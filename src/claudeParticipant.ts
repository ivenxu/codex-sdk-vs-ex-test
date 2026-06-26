import * as vscode from 'vscode';
import { query, type Options, type SDKMessage, type SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_PROVIDER_ID } from './claudeModelProvider';
import { ProxyManager } from './proxy/index';

// ─── Logger ───────────────────────────────────────────────────────────────────

function log(msg: string, ...args: unknown[]): void {
	console.log(`[claude] ${msg}`, ...args);
}

function logErr(msg: string, err: unknown): void {
	console.error(`[claude] ${msg}`, err);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface TurnMetadata {
	/** Persisted SDK session ID so subsequent turns can resume. */
	sessionId: string;
}

// ─── Participant ──────────────────────────────────────────────────────────────

/**
 * Chat participant that bridges VS Code Chat to Claude Code via
 * @anthropic-ai/claude-agent-sdk.
 *
 * The SDK spawns the system-installed `claude` binary internally — no binary
 * bundling needed. API routing goes through our messages proxy:
 *
 *   ANTHROPIC_BASE_URL      → local messages proxy (http://127.0.0.1:N)
 *   ANTHROPIC_AUTH_TOKEN    → proxy nonce (sent as Authorization: Bearer)
 *
 * The proxy translates Anthropic Messages API calls to VS Code's LM API,
 * routing to whichever model the user selects in the chat picker.
 *
 * Session design: one SDK session per VS Code chat conversation. The SDK
 * persists session history in ~/.claude/. We pass `resume: sessionId` on
 * subsequent turns so the SDK picks up where it left off.
 *
 * Model routing:
 *   - vendor === CLAUDE_PROVIDER_ID (native Claude models) → SDK uses direct
 *     Anthropic API via proxy → messages proxy → VS Code LM (claude family)
 *   - any other vendor → same proxy path, proxy routes to that VS Code model
 */
export class ClaudeParticipant {
	/** sessionId → abortController so we can cancel in-flight queries */
	private readonly _sessions = new Map<string, AbortController>();

	/**
	 * @param storagePath  Extension's global storage path (from context.globalStorageUri.fsPath).
	 *                     Passed as CLAUDE_CONFIG_DIR to isolate our sessions from
	 *                     VS Code's built-in Claude agent which uses ~/.claude.
	 */
	constructor(private readonly proxyManager: ProxyManager, private readonly storagePath: string) {}

	async handleRequest(
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<vscode.ChatResult> {
		const info = this.proxyManager.info;
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

		// ── 1. Session management ────────────────────────────────────────────
		const savedMeta = findMetaInHistory(context.history);
		const savedSessionId = savedMeta?.sessionId;
		log('session lookup', { savedSessionId, historyLength: context.history.length });

		const ac = new AbortController();
		if (savedSessionId) {
			this._sessions.set(savedSessionId, ac);
		}
		const cancellationSub = token.onCancellationRequested(() => ac.abort());

		// ── 2. Build SDK options ──────────────────────────────────────────────
		// ANTHROPIC_BASE_URL routes to our messages proxy.
		// ANTHROPIC_AUTH_TOKEN (not ANTHROPIC_API_KEY) is sent as Authorization: Bearer
		// which our proxy validates. ANTHROPIC_API_KEY would be sent as x-api-key
		// and would bypass the proxy auth check.
		const options: Options = {
			cwd,
			abortController: ac,
			// Resume a previous session if we have one
			...(savedSessionId ? { resume: savedSessionId } : {}),
			env: {
				...process.env,
				ANTHROPIC_BASE_URL: info.messagesUrl,
				ANTHROPIC_AUTH_TOKEN: info.messagesNonce,
				// Isolate session storage from VS Code's built-in Claude agent (~/.claude)
				CLAUDE_CONFIG_DIR: this.storagePath,
			},
			canUseTool: async (toolName, _input, _extra) => {
				log('canUseTool', toolName);
				// Route through VS Code confirmation dialog
				try {
					const result = await vscode.lm.invokeTool(
						'vscode_get_confirmation',
						{
							input: {
								title: 'Claude Code — Allow tool?',
								message: `**Tool:** \`${toolName}\``,
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
					return typeof rawValue === 'string' && rawValue.toLowerCase() === 'yes'
					? { behavior: 'allow' as const } : { behavior: 'deny' as const, message: 'Denied by user' };
				} catch {
					return { behavior: 'deny' as const, message: 'Approval dialog failed' };
				}
			},
		};

		// ── 3. Run SDK query ──────────────────────────────────────────────────
		log('starting query', { prompt: request.prompt.slice(0, 120), resume: savedSessionId ?? '(new)', modelId: request.model.id });
		stream.progress(savedSessionId ? 'Resuming Claude session...' : 'Starting Claude session...');

		let finalSessionId: string | undefined = savedSessionId;

		try {
			const q = query({ prompt: request.prompt, options });

			for await (const msg of q) {
				if (token.isCancellationRequested) { break; }

				if (msg.type === 'assistant') {
					const aMsg = msg as SDKAssistantMessage;
					const text = extractText(aMsg);
					if (text) {
						log('assistant delta', JSON.stringify(text).slice(0, 80));
						stream.markdown(text);
					}
					// Capture session_id from any assistant message
					if (aMsg.session_id) { finalSessionId = aMsg.session_id; }
				} else if (msg.type === 'result') {
					const r = msg as SDKMessage & { session_id?: string };
					if (r.session_id) { finalSessionId = r.session_id; }
					log('result', { sessionId: finalSessionId });
					break;
				} else if (msg.type === 'system') {
					const s = msg as SDKMessage & { subtype?: string; content?: string };
					if (s.subtype === 'init' && (s as unknown as { session_id?: string }).session_id) {
						finalSessionId = (s as unknown as { session_id: string }).session_id;
					}
				}
			}

			log('query finished', { sessionId: finalSessionId });
		} catch (err) {
			if (!token.isCancellationRequested) {
				logErr('query error', err);
				stream.markdown(`\n\n> ⚠️ Claude error: ${String(err)}\n`);
			}
		} finally {
			cancellationSub.dispose();
			if (savedSessionId) { this._sessions.delete(savedSessionId); }
		}

		// ── 4. Persist session ID for the next turn ───────────────────────────
		if (finalSessionId) {
			const metadata: TurnMetadata = { sessionId: finalSessionId };
			log('returning metadata', metadata);
			return { metadata };
		}
		return {};
	}

	dispose(): void {
		// Abort any in-flight queries
		for (const ac of this._sessions.values()) { ac.abort(); }
		this._sessions.clear();
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract plain text from a BetaMessage content array. */
function extractText(msg: SDKAssistantMessage): string {
	const content = msg.message?.content;
	if (!content) { return ''; }
	if (typeof content === 'string') { return content; }
	if (Array.isArray(content)) {
		return content
			.filter(c => typeof c === 'object' && c !== null && (c as { type?: string }).type === 'text')
			.map(c => (c as { type: string; text: string }).text)
			.join('');
	}
	return '';
}

function findMetaInHistory(
	history: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>
): TurnMetadata | undefined {
	for (let i = history.length - 1; i >= 0; i--) {
		const turn = history[i];
		if ('result' in turn) {
			const meta = (turn as vscode.ChatResponseTurn).result.metadata;
			const sessionId = meta?.['sessionId'];
			if (typeof sessionId === 'string') { return { sessionId }; }
		}
	}
	return undefined;
}
