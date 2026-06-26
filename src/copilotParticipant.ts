import * as vscode from 'vscode';
import { CopilotClient, RuntimeConnection, approveAll, type SessionConfig, type ResumeSessionConfig, type PermissionRequest, type PermissionRequestResult } from '@github/copilot-sdk';

// ─── Logger ───────────────────────────────────────────────────────────────────

function log(msg: string, ...args: unknown[]): void {
	console.log(`[copilot] ${msg}`, ...args);
}

function logErr(msg: string, err: unknown): void {
	console.error(`[copilot] ${msg}`, err);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface TurnMetadata {
	sessionId: string;
}

// ─── Participant ──────────────────────────────────────────────────────────────

/**
 * Chat participant that bridges VS Code Chat to the GitHub Copilot CLI SDK.
 *
 * Uses @github/copilot-sdk (which auto-installs @github/copilot as its
 * dependency — pure JavaScript, no native binary bundling needed).
 * The CLI entry point is resolved from the extension's own node_modules.
 *
 * Auth: GitHub session via vscode.authentication ('github' provider).
 * Session: one SDK session per VS Code chat conversation, persisted across
 * turns via session ID stored in ChatResult.metadata.
 */
export class CopilotParticipant {
	private _client: CopilotClient | null = null;

	/**
	 * @param storagePath  Extension's global storage path (from context.globalStorageUri.fsPath).
	 *                     Used as the Copilot runtime baseDirectory so our sessions are isolated
	 *                     from VS Code's built-in Copilot CLI agent (~/.copilot).
	 */
	constructor(private readonly storagePath: string) {}

	async handleRequest(
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<vscode.ChatResult> {
		// ── 1. Get GitHub auth token ──────────────────────────────────────────
		let githubSession: vscode.AuthenticationSession;
		try {
			githubSession = await vscode.authentication.getSession(
				'github',
				['read:user', 'copilot'],
				{ createIfNone: true }
			);
		} catch (err) {
			stream.markdown('> ⚠️ GitHub authentication required. Please sign in to use the Copilot CLI agent.\n\n');
			return {};
		}
		log('authenticated as', githubSession.account.label);

		// ── 2. Ensure CopilotClient is started ───────────────────────────────
		if (!this._client) {
			log('starting CopilotClient (bundled runtime, baseDirectory:', this.storagePath, ')');
			stream.progress('Connecting to Copilot CLI...');
			this._client = new CopilotClient({
				gitHubToken: githubSession.accessToken,
				baseDirectory: this.storagePath,  // isolate from ~/.copilot used by built-in agent
				connection: RuntimeConnection.forStdio(),  // uses bundled @github/copilot runtime
			});
			await this._client.start();
			log('CopilotClient started');
		}

		// ── 3. Session lookup ─────────────────────────────────────────────────
		const savedSessionId = findSessionIdInHistory(context.history);
		log('session lookup', { savedSessionId, historyLength: context.history.length });

		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

		// Build per-request permission handler
		const makePermissionHandler = () =>
			async (req: PermissionRequest, _inv: { sessionId: string }): Promise<PermissionRequestResult> => {
				log('permission request', JSON.stringify(req).slice(0, 200));
				stream.progress('Waiting for approval...');
				try {
					const result = await vscode.lm.invokeTool(
						'vscode_get_confirmation',
						{
							input: {
								title: 'Copilot CLI — Allow operation?',
								message: `**Permission request:**\n\n\`\`\`json\n${JSON.stringify(req, null, 2).slice(0, 400)}\n\`\`\``,
								confirmationType: 'basic',
							},
							toolInvocationToken: request.toolInvocationToken,
						},
						token
					);
					const firstPart = result.content.at(0);
					const rawValue: unknown = firstPart != null && typeof firstPart === 'object' && 'value' in firstPart
						? (firstPart as { value: unknown }).value
						: undefined;
					const approved = typeof rawValue === 'string' && rawValue.toLowerCase() === 'yes';
					log('permission decision:', approved ? 'approve-once' : 'reject');
					return approved ? { kind: 'approve-once' as const } : { kind: 'reject' as const };
				} catch {
					return { kind: 'reject' as const };
				}
			};

		// ── 4. Create or resume session ───────────────────────────────────────
		let sdkSession: Awaited<ReturnType<CopilotClient['createSession']>>;
		let sessionId: string;

		if (savedSessionId) {
			log('resuming session', savedSessionId);
			stream.progress('Resuming Copilot session...');
			try {
				const resumeConfig: ResumeSessionConfig = {
					workingDirectory: cwd,
					streaming: true,
					onPermissionRequest: makePermissionHandler(),
				};
				sdkSession = await this._client.resumeSession(savedSessionId, resumeConfig);
				sessionId = savedSessionId;
				log('session resumed', sessionId);
			} catch (err) {
				logErr('resume failed, starting new session', err);
				stream.progress('Starting new Copilot session...');
				const createConfig: SessionConfig = {
					workingDirectory: cwd,
					model: request.model.id,
					streaming: true,
					onPermissionRequest: makePermissionHandler(),
				};
				sdkSession = await this._client.createSession(createConfig);
				sessionId = sdkSession.sessionId;
				log('new session created', sessionId);
			}
		} else {
			log('starting new session');
			stream.progress('Starting new Copilot session...');
			const createConfig: SessionConfig = {
				workingDirectory: cwd,
				model: request.model.id,
				streaming: true,
				onPermissionRequest: makePermissionHandler(),
			};
			sdkSession = await this._client.createSession(createConfig);
			sessionId = sdkSession.sessionId;
			log('session created', sessionId);
		}

		// ── 5. Subscribe to events and send ──────────────────────────────────
		let completionResolve!: () => void;
		let completionReject!: (err: Error) => void;
		const completionPromise = new Promise<void>((resolve, reject) => {
			completionResolve = resolve;
			completionReject = reject;
		});

		sdkSession.on('assistant.message_delta', (event) => {
			const text = event.data.deltaContent;
			if (text) {
				log('delta', JSON.stringify(text).slice(0, 80));
				stream.markdown(text);
			}
		});

		sdkSession.on('session.idle', () => {
			log('session.idle — turn complete');
			completionResolve();
		});

		// Forward cancellation
		const cancellationSubscription = token.onCancellationRequested(() => {
			completionReject(new Error('Request cancelled'));
		});

		log('sending prompt', { prompt: request.prompt.slice(0, 120), sessionId, modelId: request.model.id });
		try {
			await sdkSession.send({ prompt: request.prompt });
			log('send() returned, waiting for session.idle...');
			await completionPromise;
			log('turn finished successfully');
		} finally {
			cancellationSubscription.dispose();
		}

		// ── 6. Persist session id for the next turn ───────────────────────────
		const metadata: TurnMetadata = { sessionId };
		log('returning metadata for next turn', metadata);
		return { metadata };
	}

	dispose(): void {
		// CopilotClient manages the subprocess lifecycle; no explicit teardown needed
		this._client = undefined as unknown as null;
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findSessionIdInHistory(
	history: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>
): string | undefined {
	for (let i = history.length - 1; i >= 0; i--) {
		const turn = history[i];
		if ('result' in turn) {
			const sessionId = (turn as vscode.ChatResponseTurn).result.metadata?.['sessionId'];
			if (typeof sessionId === 'string') { return sessionId; }
		}
	}
	return undefined;
}
