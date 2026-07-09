import * as vscode from 'vscode';
import {
	CopilotClient,
	RuntimeConnection,
	type SessionConfig,
	type ResumeSessionConfig,
	type PermissionRequestResult,
	type ExitPlanModeRequest,
	type ExitPlanModeResult,
} from '@github/copilot-sdk';
import { createInitialRouterState, routeSessionEvent, type RouterState } from './copilot/copilotSessionEventRouter';
import { CopilotPermissionHandler } from './copilot/copilotPermissionHandler';
import { toSdkAttachments, type CopilotMessageAttachment } from './copilot/copilotAttachments';
import { isRestrictedTelemetryEnabled } from './copilot/copilotTokenFields';
import { ProxyManager } from './proxy/index';

// ─── Logger ───────────────────────────────────────────────────────────────────

function log(msg: string, ...args: unknown[]): void {
	console.log(`[copilot] ${msg}`, ...args);
}

function logErr(msg: string, err: unknown): void {
	console.error(`[copilot] ${msg}`, err);
}

// ─── Types ────────────────────────────────────────────────────────────────────

type CopilotSession = Awaited<ReturnType<CopilotClient['createSession']>>;

interface TurnMetadata {
	sessionId: string;
	tokenUsage?: { inputTokens: number; outputTokens: number };
	modelId?: string;
}

/** Mutable context for the turn currently executing on a session. */
interface TurnContext {
	stream: vscode.ChatResponseStream;
	permission: CopilotPermissionHandler;
	routerState: RouterState;
	resolveIdle: () => void;
	toolInvocationToken: vscode.ChatRequest['toolInvocationToken'];
	token: vscode.CancellationToken;
}

interface SessionEntry {
	sessionId: string;
	session: CopilotSession;
	/** Promise chain that serializes turns on this session. */
	sequencer: Promise<void>;
	/** Context of the in-flight turn, or null when idle. */
	current: TurnContext | null;
	/** Unsubscribe from the session event stream. */
	unsubscribe: () => void;
}

// ─── Participant ──────────────────────────────────────────────────────────────

/**
 * Chat participant that bridges VS Code Chat to the GitHub Copilot CLI SDK.
 *
 * Maintains one SDK session per VS Code chat conversation (keyed by SDK session
 * id, persisted across turns via `ChatResult.metadata`). Turns are serialized
 * per session; the full session-event stream is routed to the chat UI; and
 * permission requests flow through a tiered auto-approval handler.
 */
export class CopilotParticipant {
	private _client: CopilotClient | null = null;
	private _lastToken: string | undefined;
	private readonly _sessions = new Map<string, SessionEntry>();

	/**
	 * @param storagePath Extension global storage path, used as the Copilot runtime
	 *                    baseDirectory so sessions are isolated from ~/.copilot.
	 * @param proxyManager Shared LM proxy; the runtime's model calls are always
	 *                    routed through it to VS Code LM.
	 */
	constructor(
		private readonly storagePath: string,
		private readonly proxyManager: ProxyManager,
	) {}

	async handleRequest(
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
	): Promise<vscode.ChatResult> {
		// ── 1. Auth ───────────────────────────────────────────────────────────
		let githubSession: vscode.AuthenticationSession;
		try {
			githubSession = await vscode.authentication.getSession('github', ['read:user', 'copilot'], { createIfNone: true });
		} catch {
			stream.markdown('> ⚠️ GitHub authentication required. Please sign in to use the Copilot CLI agent.\n\n');
			return {};
		}
		log('authenticated', { account: githubSession.account.label });

		// ── 2. Ensure client (handles token rotation) ────────────────────────
		await this._ensureClient(githubSession.accessToken, stream);
		const client = this._client!;

		// ── 3. Resolve session (create / resume / reuse) ──────────────────────
		const savedSessionId = findSessionIdInHistory(context.history);
		log('handleRequest', {
			modelId: request.model.id,
			savedSessionId,
			historyLength: context.history.length,
			references: request.references.length,
			activeSessions: this._sessions.size,
		});
		let entry: SessionEntry;
		try {
			entry = await this._getOrCreateSession(client, savedSessionId, request, stream);
		} catch (err) {
			logErr('failed to establish session', err);
			stream.markdown('> ⚠️ Failed to start the Copilot CLI session.\n\n');
			return {};
		}

		// ── 4. Queue the turn behind the session sequencer ────────────────────
		return this._queueTurn(entry, () => this._runTurn(entry, request, stream, token));
	}

	// ── Turn execution ──────────────────────────────────────────────────────

	private async _runTurn(
		entry: SessionEntry,
		request: vscode.ChatRequest,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
	): Promise<vscode.ChatResult> {
		const slash = parseLeadingSlashCommand(request.prompt);

		// Slash command: /compact — compact history and finish the turn.
		if (slash.command === 'compact') {
			log('slash /compact', { sessionId: entry.sessionId });
			try {
				await entry.session.rpc.history.compact();
				stream.markdown('_Compaction completed._');
				log('compaction done', { sessionId: entry.sessionId });
			} catch (err) {
				logErr('compaction failed', err);
				stream.markdown('> ⚠️ Compaction failed.\n');
			}
			return { metadata: { sessionId: entry.sessionId } satisfies TurnMetadata };
		}

		const attachments = toSdkAttachments(request);
		const attachedPaths = collectAttachedPaths(attachments);
		const permission = new CopilotPermissionHandler(stream, request.toolInvocationToken, token, attachedPaths);

		// Establish the mutable turn context read by the shared event/permission callbacks.
		let resolveIdle!: () => void;
		const idle = new Promise<void>(resolve => { resolveIdle = resolve; });
		const routerState = createInitialRouterState();
		entry.current = { stream, permission, routerState, resolveIdle, toolInvocationToken: request.toolInvocationToken, token };

		// Cancellation → abort the SDK turn, then release the wait.
		const cancelSub = token.onCancellationRequested(() => {
			log('cancellation requested', { sessionId: entry.sessionId });
			void entry.session.abort().catch(() => { /* best-effort */ });
			resolveIdle();
		});

		const agentMode: 'plan' | 'interactive' | 'autopilot' =
			slash.command === 'plan' ? 'plan'
				: slash.command === 'autopilot' ? 'autopilot'
					: 'interactive';
		const prompt = slash.command ? slash.rest : request.prompt;

		log('starting turn', {
			sessionId: entry.sessionId,
			agentMode,
			slash: slash.command,
			promptLen: prompt.length,
			attachments: attachments.length,
		});
		try {
			await entry.session.send({
				prompt,
				attachments: attachments.length ? attachments : undefined,
				agentMode,
			});
			log('send() dispatched, awaiting idle', { sessionId: entry.sessionId });
			await idle;
			log('turn idle', {
				sessionId: entry.sessionId,
				inputTokens: routerState.usage.inputTokens,
				outputTokens: routerState.usage.outputTokens,
				modelId: routerState.modelId,
			});
		} catch (err) {
			logErr('turn failed', err);
			stream.markdown(`\n\n> ⚠️ Copilot error: ${err instanceof Error ? err.message : String(err)}\n`);
		} finally {
			cancelSub.dispose();
			permission.dispose();
			entry.current = null;
		}

		const metadata: TurnMetadata = {
			sessionId: entry.sessionId,
			tokenUsage: { inputTokens: routerState.usage.inputTokens, outputTokens: routerState.usage.outputTokens },
			modelId: routerState.modelId ?? request.model.id,
		};
		return { metadata };
	}

	/** Serialize turns per session so a second message waits for the first to finish. */
	private _queueTurn<T>(entry: SessionEntry, fn: () => Promise<T>): Promise<T> {
		const run = entry.sequencer.then(fn, fn);
		entry.sequencer = run.then(() => undefined, () => undefined);
		return run;
	}

	// ── Session management ────────────────────────────────────────────────────

	private async _getOrCreateSession(
		client: CopilotClient,
		savedSessionId: string | undefined,
		request: vscode.ChatRequest,
		stream: vscode.ChatResponseStream,
	): Promise<SessionEntry> {
		if (savedSessionId) {
			const existing = this._sessions.get(savedSessionId);
			if (existing) {
				log('reusing warm session', { sessionId: savedSessionId });
				return existing;
			}
			stream.progress('Resuming Copilot session…');
			log('resuming session from disk', { sessionId: savedSessionId });
			try {
				const entry = this._newEntry();
				const resumeConfig: ResumeSessionConfig = {
					workingDirectory: workspaceCwd(),
					streaming: true,
					onPermissionRequest: this._permissionCallback(entry),
					onExitPlanModeRequest: this._exitPlanModeCallback(entry),
				};
				const session = await client.resumeSession(savedSessionId, resumeConfig);
				return this._attachEntry(entry, session);
			} catch (err) {
				logErr('resume failed, creating new session', err);
			}
		}

		stream.progress('Starting Copilot session…');
		log('creating new session', { model: request.model.id });
		const entry = this._newEntry();
		const createConfig: SessionConfig = {
			workingDirectory: workspaceCwd(),
			model: request.model.id,
			streaming: true,
			onPermissionRequest: this._permissionCallback(entry),
			onExitPlanModeRequest: this._exitPlanModeCallback(entry),
		};
		const session = await client.createSession(createConfig);
		return this._attachEntry(entry, session);
	}

	private _newEntry(): SessionEntry {
		return { sessionId: '', session: null as unknown as CopilotSession, sequencer: Promise.resolve(), current: null, unsubscribe: () => { /* set later */ } };
	}

	/** Fill in the session, subscribe to its event stream, and register the entry. */
	private _attachEntry(entry: SessionEntry, session: CopilotSession): SessionEntry {
		entry.session = session;
		entry.sessionId = session.sessionId;
		entry.unsubscribe = session.on((event) => {
			const current = entry.current;
			if (current) {
				routeSessionEvent(event, current.stream, current.routerState, current.resolveIdle);
			}
		});
		this._sessions.set(entry.sessionId, entry);
		log('session ready', entry.sessionId);
		return entry;
	}

	/** Stable permission callback that delegates to the current turn's handler. */
	private _permissionCallback(entry: SessionEntry): (req: Parameters<CopilotPermissionHandler['handle']>[0]) => Promise<PermissionRequestResult> {
		return (req) => {
			const current = entry.current;
			if (!current) {
				log('permission request dropped (no active turn)', { sessionId: entry.sessionId, kind: (req as { kind?: string }).kind });
				return Promise.resolve({ kind: 'reject' } as PermissionRequestResult);
			}
			return current.permission.handle(req);
		};
	}

	/** Stable exit-plan-mode callback: asks the user to approve leaving plan mode. */
	private _exitPlanModeCallback(entry: SessionEntry): (req: ExitPlanModeRequest) => Promise<ExitPlanModeResult> {
		return async (req) => {
			const current = entry.current;
			if (!current) {
				return { approved: false };
			}
			log('exit plan mode requested', { sessionId: entry.sessionId, summary: req.summary?.slice(0, 120) });
			try {
				const result = await vscode.lm.invokeTool(
					'vscode_get_confirmation',
					{
						input: {
							title: 'Copilot CLI — Exit plan mode and start executing?',
							message: req.summary || 'The agent has finished planning and wants to begin making changes.',
							confirmationType: 'basic',
						},
						toolInvocationToken: current.toolInvocationToken,
					},
					current.token,
				);
				const firstPart = result.content.at(0);
				const rawValue: unknown = firstPart != null && typeof firstPart === 'object' && 'value' in firstPart
					? (firstPart as { value: unknown }).value
					: undefined;
				const approved = typeof rawValue === 'string' && rawValue.toLowerCase() === 'yes';
				log('exit plan mode decision', { sessionId: entry.sessionId, approved });
				return { approved };
			} catch {
				return { approved: false };
			}
		};
	}

	private async _ensureClient(githubToken: string, stream: vscode.ChatResponseStream): Promise<void> {
		// Restart the client when the token rotates, but only when nothing is in
		// flight (env is fixed at spawn time).
		const needsRestart = this._client !== null
			&& this._lastToken !== githubToken
			&& this._sessions.size === 0;
		if (needsRestart) {
			log('restarting client (token rotated)');
			await this._client!.stop().catch(() => { /* best-effort */ });
			this._client = null;
		}
		this._lastToken = githubToken;

		if (!this._client) {
			stream.progress('Connecting to Copilot CLI…');
			const restrictedTelemetry = isRestrictedTelemetryEnabled(githubToken);

			// Always route the runtime's model calls through our localhost proxy →
			// VS Code LM. `COPILOT_API_URL` overrides the model endpoint; the picked
			// model flows via the per-session `model` id in the request body; disabling
			// WebSocket keeps all traffic on the HTTP Responses transport the proxy
			// understands. (`gitHubToken` only authenticates the runtime itself — it
			// does not select the model, which always resolves through the proxy.)
			const info = await this.proxyManager.start();
			log('model proxy', { responsesUrl: info.responsesUrl });
			const env: Record<string, string | undefined> = {
				...process.env,
				COPILOT_API_URL: info.responsesUrl,
				GITHUB_COPILOT_API_TOKEN: info.responsesNonce,
				COPILOT_CLI_DISABLE_WEBSOCKET_RESPONSES: 'true',
			};

			log('starting CopilotClient', { restrictedTelemetry, baseDirectory: this.storagePath });
			this._client = new CopilotClient({
				gitHubToken: githubToken,
				baseDirectory: this.storagePath,
				connection: RuntimeConnection.forStdio(),
				env,
			});
			await this._client.start();
			log('CopilotClient started');
		}
	}

	dispose(): void {
		log('dispose', { activeSessions: this._sessions.size });
		for (const entry of this._sessions.values()) {
			entry.current?.permission.dispose();
			try { entry.unsubscribe(); } catch { /* ignore */ }
		}
		this._sessions.clear();
		void this._client?.stop().catch(() => { /* best-effort */ });
		this._client = null;
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function workspaceCwd(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function collectAttachedPaths(attachments: readonly CopilotMessageAttachment[]): ReadonlySet<string> {
	const paths = new Set<string>();
	for (const a of attachments) {
		if (a.type === 'file' || a.type === 'directory') {
			paths.add(a.path);
		} else if (a.type === 'selection') {
			paths.add(a.filePath);
		}
	}
	return paths;
}

interface ParsedSlashCommand {
	command?: 'compact' | 'plan' | 'autopilot';
	rest: string;
}

function parseLeadingSlashCommand(prompt: string): ParsedSlashCommand {
	const match = /^\s*\/(compact|plan|autopilot)\b\s*([\s\S]*)$/i.exec(prompt);
	if (match) {
		return { command: match[1].toLowerCase() as 'compact' | 'plan' | 'autopilot', rest: match[2] };
	}
	return { rest: prompt };
}

function findSessionIdInHistory(
	history: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>,
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
