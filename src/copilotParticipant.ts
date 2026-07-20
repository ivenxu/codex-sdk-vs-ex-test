import * as vscode from 'vscode';
import {
	BuiltInTools,
	CopilotClient,
	RuntimeConnection,
	type SessionConfig,
	type ResumeSessionConfig,
	type NamedProviderConfig,
	type ProviderModelConfig,
	type MCPServerConfig,
	type PermissionRequestResult,
	type ExitPlanModeRequest,
	type ExitPlanModeResult,
	type Tool,
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

		// ── 2. Ensure client (handles token rotation) ────────────────────
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

		// Safety timeout: if the model doesn't start responding within 120s
		// (hasOutput stays false), resolve the idle so the turn doesn't hang forever.
		const TURN_TIMEOUT_MS = 120_000;
		const timeoutHandle = setTimeout(() => {
			if (!routerState.hasOutput && !routerState.completed) {
				logErr('turn timed out waiting for model output', { sessionId: entry.sessionId });
				resolveIdle();
			}
		}, TURN_TIMEOUT_MS);

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
			clearTimeout(timeoutHandle);
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
				const byok = this._byokSessionConfig(savedSessionId, request.model.id);
				const resumeConfig: ResumeSessionConfig = {
					workingDirectory: workspaceCwd(),
					streaming: true,
					...byok,
					// VS Code tools: additive — updates the tool list for the resumed session.
					tools: buildVsCodeTools(),
					// MCP fields intentionally OMITTED on resume:
					// - mcpServers: {} (empty) on resume tells the runtime to REPLACE the server
					//   list with nothing, clearing any MCP servers started at creation time.
					// - enableConfigDiscovery / enableMcpApps on resume trigger a re-init scan
					//   that can emit a premature session.idle, ending the turn with 0 tokens.
					// The session's MCP config is already baked in from createSession.
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
		const vendor = 'copilot';
		const qualifiedModelId = `${vendor}/${request.model.id}`;
		log('creating new session', { model: qualifiedModelId });
		const entry = this._newEntry();
		const byok = this._byokSessionConfig(/* sessionId unknown yet — use placeholder */ 'new', request.model.id);
		const vsCodeTools = buildVsCodeTools();
		const mcpServers = buildMcpServerConfig();
		log('vscode tools registered', { count: vsCodeTools.length, names: vsCodeTools.slice(0, 10).map(t => t.name) });
		log('mcp servers', { count: Object.keys(mcpServers).length, names: Object.keys(mcpServers) });
		const createConfig: SessionConfig = {
			workingDirectory: workspaceCwd(),
			// Provider-qualified id ('copilot/gpt-4.1') tells the runtime to use the
			// BYOK provider. A bare id would be treated as a CAPI model selection,
			// bypassing the providers/models config entirely (SDK rpc.d.ts:6229).
			model: qualifiedModelId,
			streaming: true,
			...byok,
			tools: vsCodeTools,
			mcpServers,
			enableConfigDiscovery: true,
			enableMcpApps: true,
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
			// Log every event for debugging — helps identify unexpected idles, missing
			// model calls, and initialization sequences.
			log(`event: ${event.type}`, { sessionId: entry.sessionId.slice(0, 8), hasCurrent: !!current });
			if (event.type === 'external_tool.requested') {
				// VS Code tool call — invoke via vscode.lm.invokeTool and feed result back.
				void this._handleExternalTool(entry, event.data);
				return;
			}
			if (event.type === 'session.shutdown' && event.data.shutdownType === 'error') {
				// Fatal runtime crash — evict the session so the next message starts fresh.
				log('session.shutdown error — evicting session', { sessionId: entry.sessionId, reason: event.data.errorReason });
				this._sessions.delete(entry.sessionId);
			}
			if (current) {
				routeSessionEvent(event, current.stream, current.routerState, current.resolveIdle);
			}
		});
		this._sessions.set(entry.sessionId, entry);
		log('session ready', entry.sessionId);
		return entry;
	}

	/**
	 * Handles `external_tool.requested` events by invoking the named VS Code LM
	 * tool and returning the result to the runtime via `session.rpc.tools.handlePendingToolCall`.
	 *
	 * Declaration-only SDK `Tool` objects (no `handler`) trigger this event when the
	 * runtime wants to call a VS Code tool. Mirrors the host agent's `_createClientSdkTools`
	 * pattern but without the workbench protocol layer.
	 */
	private async _handleExternalTool(
		entry: SessionEntry,
		data: { requestId: string; toolName: string; arguments?: Record<string, unknown>; toolCallId: string },
	): Promise<void> {
		const { requestId, toolName, arguments: args, toolCallId } = data;
		const current = entry.current;
		log('external_tool.requested', { requestId: requestId.slice(0, 13), toolName, toolCallId: toolCallId.slice(0, 13) });
		try {
			const result = await vscode.lm.invokeTool(
				toolName,
				{ input: args ?? {}, toolInvocationToken: current?.toolInvocationToken },
				current?.token ?? new vscode.CancellationTokenSource().token,
			);
			const text = result.content
				.map(part => {
					if (part instanceof vscode.LanguageModelTextPart) { return part.value; }
					if (typeof part === 'object' && part !== null && 'value' in part) { return String((part as { value: unknown }).value); }
					return '';
				})
				.join('');
			log('external_tool result', { requestId: requestId.slice(0, 13), toolName, len: text.length });
			await entry.session.rpc.tools.handlePendingToolCall({
				requestId,
				result: { textResultForLlm: text || '(empty)', resultType: 'success' },
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logErr(`external_tool failed: ${toolName}`, err);
			await entry.session.rpc.tools.handlePendingToolCall({
				requestId,
				error: message,
			}).catch(() => { /* best-effort */ });
		}
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
		// flight (the client env is fixed at spawn; the model/provider are per-session).
		const needsRestart = this._client !== null
			&& this._lastToken !== githubToken
			&& this._sessions.size === 0;
		if (needsRestart) {
			log('restarting client (token rotated)');
			await this._client!.stop().catch(() => { /* best-effort */ });
			this._client = null;
		}
		this._lastToken = githubToken;

		// Ensure the localhost proxy is up so the per-session provider config can
		// point at it (see `_providerConfig`).
		await this.proxyManager.start();

		if (!this._client) {
			stream.progress('Connecting to Copilot CLI…');
			const restrictedTelemetry = isRestrictedTelemetryEnabled(githubToken);

			// On Linux (including WSL) the Copilot CLI's default PTY-backed shell cannot
			// start inside the MXC bubblewrap sandbox because the MXC binaries
			// (`@microsoft/mxc-sdk`) are only present in the VS Code host-agent distribution,
			// not in a standalone extension's node_modules. Without the sandbox engine the
			// shell tool hangs and eventually times out. Setting SHELL_SPAWN_BACKEND forces
			// the CLI to use a non-sandboxed pipe-based spawn for each shell command, which
			// works correctly in both native Linux and WSL. The VS Code host agent sets the
			// same flag on Linux for the same reason (see copilotAgent.ts `_ensureClient`).
			const env: Record<string, string | undefined> | undefined =
				process.platform === 'linux'
					? {
						...process.env,
						COPILOT_CLI_ENABLED_FEATURE_FLAGS: [
							...(process.env['COPILOT_CLI_ENABLED_FEATURE_FLAGS'] ?? '').split(',').map(f => f.trim()).filter(Boolean),
							'SHELL_SPAWN_BACKEND',
						].join(','),
					  }
					: undefined;

			log('starting CopilotClient', { restrictedTelemetry, baseDirectory: this.storagePath, platform: process.platform, shellSpawnBackend: process.platform === 'linux' });
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

	/**
	 * SDK-native BYOK provider+model config that routes this session's model calls
	 * to our localhost OpenAI-Completions proxy → VS Code LM.
	 *
	 * Mirrors the VS Code host agent's `resolveByokSessionConfig` exactly, except
	 * we use `wireApi:'responses'` (OpenAI Responses format) because that is what
	 * our existing `responsesProxy` speaks — the same proxy that already backs the
	 * Codex participant.
	 *
	 * The participant vendor is 'copilot' (the VS Code LM vendor for Copilot-exposed models).
	 * The nonce + sessionId bearer token matches the proxy's auth check.
	 *
	 * NOTE: the env-var BYOK path (COPILOT_PROVIDER_*) is only read by the standalone
	 * `copilot` CLI binary, NOT by the SDK-spawned runtime — confirmed by inspecting
	 * the SDK dist (zero references). The correct mechanism for the SDK-spawned runtime
	 * is SessionConfig.providers/models, as used by the VS Code host agent.
	 */
	private _byokSessionConfig(sessionId: string, modelId: string): { providers: NamedProviderConfig[]; models: ProviderModelConfig[] } {
		const info = this.proxyManager.info;
		const vendor = 'copilot';
		return {
			providers: [{
				name: vendor,
				type: 'openai',
				wireApi: 'responses',
				baseUrl: info.responsesUrl,
				bearerToken: `${info.responsesNonce}.${sessionId}`,
			}],
			models: [{
				id: modelId,
				provider: vendor,
			}],
		};
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

/**
 * Enumerate all VS Code Language Model tools and return them as declaration-only
 * SDK `Tool` objects (no `handler`). Without a handler the runtime fires
 * `external_tool.requested` events when it wants to call one, which we handle
 * in `_handleExternalTool` via `vscode.lm.invokeTool`. This is the participant
 * equivalent of the host agent's `_createClientSdkTools()`.
 *
 * `skipPermission: true` because the Copilot permission handler would require an
 * approval dialog for every VS Code tool call; VS Code's own tool invocation
 * security model governs access instead.
 */
/** SDK-reserved built-in tool names that must NOT be registered as VS Code tools.
 * These are the Copilot CLI's own internal dispatchers (skill, subagent, …).
 * Registering a VS Code LM tool with the same name would override them and break
 * features like MCP skill invocation, even with overridesBuiltInTool: true.
 */
const COPILOT_BUILTIN_TOOL_NAMES = new Set<string>([
	...BuiltInTools.Isolated,
]);

function buildVsCodeTools(): Tool[] {
	const tools = vscode.lm.tools ?? [];
	const filtered = tools.filter(t => !COPILOT_BUILTIN_TOOL_NAMES.has(t.name));
	const skipped = tools.length - filtered.length;
	if (skipped > 0) {
		log('buildVsCodeTools: skipped built-in name collisions', { skipped, names: tools.filter(t => COPILOT_BUILTIN_TOOL_NAMES.has(t.name)).map(t => t.name) });
	}
	return filtered.map(t => ({
		name: t.name,
		description: t.description ?? '',
		parameters: (t.inputSchema as Record<string, unknown> | undefined) ?? { type: 'object', properties: {} },
		skipPermission: true,
		// Some VS Code LM tools share names with non-isolated Copilot CLI built-ins.
		// The SDK requires this flag when a name collides with a built-in; without it
		// session.error fires with "conflicts with a built-in tool".
		overridesBuiltInTool: true,
	}));
}

/**
 * Build MCP server config from two sources, merged together:
 *
 *  1. `mcpServers` — VS Code's own top-level MCP setting (used by VS Code Chat
 *     / GitHub Copilot extension). This is where most users configure servers.
 *
 *  2. `copilotcli.mcpServers` — Our extension-specific override. Entries here
 *     take precedence over same-named entries from source 1, allowing users to
 *     supply auth headers or alternative configs for servers already in source 1.
 *
 * Accepts either a stdio server (has `command`) or an HTTP/SSE server (has
 * `url`); silently skips malformed entries. Returns an empty map when no
 * servers are configured (the runtime will still auto-discover `.mcp.json`
 * and `.vscode/mcp.json` in the workspace because we set `enableConfigDiscovery`).
 */
function buildMcpServerConfig(): Record<string, MCPServerConfig> {
	// Source 1: global VS Code MCP setting used by VS Code Chat
	const global = vscode.workspace.getConfiguration().get<Record<string, unknown>>('mcpServers') ?? {};
	// Source 2: our extension-specific setting (higher priority)
	const ours = vscode.workspace.getConfiguration('copilotcli').get<Record<string, unknown>>('mcpServers') ?? {};
	// Merge — ours wins on conflict
	const merged: Record<string, unknown> = { ...global, ...ours };

	const result: Record<string, MCPServerConfig> = {};
	for (const [name, server] of Object.entries(merged)) {
		if (!server || typeof server !== 'object') { continue; }
		const s = server as Record<string, unknown>;
		if (typeof s['command'] === 'string') {
			result[name] = {
				type: 'stdio',
				command: s['command'],
				...(Array.isArray(s['args']) ? { args: s['args'] as string[] } : {}),
				...(s['env'] && typeof s['env'] === 'object' ? { env: s['env'] as Record<string, string> } : {}),
				...(typeof s['workingDirectory'] === 'string' ? { workingDirectory: s['workingDirectory'] } : {}),
			};
		} else if (typeof s['url'] === 'string') {
			result[name] = {
				type: 'http',
				url: s['url'],
				...(s['headers'] && typeof s['headers'] === 'object' ? { headers: s['headers'] as Record<string, string> } : {}),
			};
		}
		// Silently skip entries with neither command nor url.
	}
	return result;
}
