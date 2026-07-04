/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AppServerConnection } from './appServer/connection';
import { resolveBinary } from './appServer/client';
import { CODEX_PROVIDER_ID } from './codexModelProvider';
import { ProxyManager } from './proxy/index';
import { DynamicToolManager } from './tools/dynamicToolManager';
import { VS_CODE_TOOL_INSTRUCTIONS } from './constants/toolInstructions';
import { PendingRequestRegistry } from './util/pendingRequestRegistry';
import type {
	DynamicToolSpec,
	Thread, DynamicToolCallParams, DynamicToolCallResponse,
	AgentMessageDeltaNotification,
	TurnCompletedNotification,
	TurnStartedNotification,
	ItemStartedNotification,
	ItemCompletedNotification,
	ReasoningSummaryPartAddedNotification,
	ReasoningSummaryTextDeltaNotification,
	ReasoningTextDeltaNotification,
	CommandExecutionOutputDeltaNotification,
	FileChangePatchUpdatedNotification,
	McpToolCallProgressNotification,
	ThreadTokenUsageUpdatedNotification,
	CommandExecutionRequestApprovalParams,
	FileChangeRequestApprovalParams,
	FileUpdateChange,
} from './protocol/types';

// ─── Logger ───────────────────────────────────────────────────────────────────

function log(msg: string, ...args: unknown[]): void {
	console.log(`[codex] ${msg}`, ...args);
}

function logErr(msg: string, err: unknown): void {
	console.error(`[codex] ${msg}`, err);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface TurnMetadata {
	threadId: string;
}

type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

interface SessionState {
	/** The active codex Thread for this session. */
	thread: Thread;
	/** The last tool hash used for this session. */
	lastToolsHash: string | null;
	/** The current app-server turn id while a turn is in-flight. */
	currentAppTurnId?: string;
	/** Per-turn file change cache — mirrors agent-host's ICodexSessionMapState.itemToToolCall */
	pendingFileChanges: Map<string, FileUpdateChange[]>;
	/** Parked command-execution approval requests. */
	pendingCommandApprovals: PendingRequestRegistry<ApprovalDecision>;
	/** Parked file-change approval requests. */
	pendingFileChangeApprovals: PendingRequestRegistry<ApprovalDecision>;
	/** Parked dynamic tool call requests. */
	pendingToolCalls: PendingRequestRegistry<DynamicToolCallResponse>;
	/** Whether a turn is currently active (item stream is being processed). */
	turnActive: boolean;
	/** Resolve when the turn completes (success or failure). */
	turnDone: Promise<void>;
	turnResolve: () => void;
	turnReject: (err: Error) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// ─── Participant ────────────────────────────────────────────────────────────────

export class CodexParticipant {
	private nativeConn: AppServerConnection | null = null;
	private proxyConn: AppServerConnection | null = null;
	/** Per-session state keyed by threadId. */
	private readonly _sessions = new Map<string, SessionState>();

	constructor(
		private readonly proxyManager: ProxyManager,
		private readonly _toolManager: DynamicToolManager,
	) {
		// Reject all pending registries when the connection drops.
		// This prevents dangling promises from blocking codex.
		this._onConnectionExit = this._onConnectionExit.bind(this);
	}

	private _onConnectionExit(): void {
		for (const session of this._sessions.values()) {
			session.pendingCommandApprovals.denyAll('cancel');
			session.pendingFileChangeApprovals.denyAll('cancel');
			session.pendingToolCalls.rejectAll(new Error('Codex app-server disconnected'));
			if (session.turnActive) {
				session.turnActive = false;
				session.turnReject(new Error('Codex app-server disconnected; session must restart.'));
			}
		}
	}

	private _ensureConnection(routing: 'native' | 'proxy', binaryPath: string, cwd?: string): AppServerConnection {
		if (routing === 'native') {
			if (!this.nativeConn) {
				this.nativeConn = new AppServerConnection({ binaryPath, cwd });
				this.nativeConn.on('exit', this._onConnectionExit);
			}
			return this.nativeConn;
		}
		if (!this.proxyConn) {
			const info = this.proxyManager.info;
			this.proxyConn = new AppServerConnection({ binaryPath, cwd, proxyBaseUrl: info.responsesUrl, proxyApiKey: info.responsesNonce });
			this.proxyConn.on('exit', this._onConnectionExit);
		}
		return this.proxyConn;
	}

	async handleRequest(
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
	): Promise<vscode.ChatResult> {
		const routing: 'native' | 'proxy' = request.model.vendor === CODEX_PROVIDER_ID ? 'native' : 'proxy';
		log('routing', { modelId: request.model.id, routing });

		if (routing === 'proxy') {
			await this.proxyManager.ready;
		}

		const binaryPath = resolveBinary(vscode.workspace.getConfiguration('codex').get<string>('binaryPath') ?? '');
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const conn = this._ensureConnection(routing, binaryPath, cwd);

		if (!conn.isConnected()) {
			stream.progress('Connecting to Codex...');
			await conn.connect();
		}

		const savedMeta = findMetaInHistory(context.history);
		const savedThreadId = savedMeta?.threadId;
		log('session lookup', { savedThreadId, routing });

		// ── Dynamic tool discovery ──
		const dynamicTools = await this._toolManager.buildDynamicTools();
		log('dynamic tools built', { count: dynamicTools.length, names: dynamicTools.map(t => t.name).slice(0, 20) });
		const newToolsHash = hashTools(dynamicTools);

		let codexThread: Thread;
		let session = savedThreadId ? this._sessions.get(savedThreadId) : undefined;
		const toolsChanged = session?.lastToolsHash !== null && session?.lastToolsHash !== newToolsHash;

		if (savedThreadId) {
			if (session) {
				if (toolsChanged) {
					stream.progress('Tool set changed; continuing with current session (new tools ignored).');
					log('tools changed for existing session; ignoring new tools', { threadId: session.thread.id, oldHash: session.lastToolsHash, newHash: newToolsHash });
				}
				codexThread = session.thread;
			} else {
				stream.progress('Resuming session...');
				try {
					codexThread = await conn.resumeThread({ threadId: savedThreadId, excludeTurns: true });
				} catch (err) {
					logErr('resume failed', err);
					stream.progress('Starting new session...');
					codexThread = await conn.startThread({
						model: request.model.id, cwd,
						approvalPolicy: 'untrusted', sandbox: 'workspace-write',
						dynamicTools, developerInstructions: VS_CODE_TOOL_INSTRUCTIONS,
					});
				}
			}
		} else {
			stream.progress('Starting new session...');
			codexThread = await conn.startThread({
				model: request.model.id, cwd,
				approvalPolicy: 'untrusted', sandbox: 'workspace-write',
				dynamicTools, developerInstructions: VS_CODE_TOOL_INSTRUCTIONS,
			});
		}

		// ── Set up per-session state ──
		session = this._sessions.get(codexThread.id);
		if (!session) {
			let turnResolve!: () => void;
			let turnReject!: (err: Error) => void;
			const turnDone = new Promise<void>((resolve, reject) => { turnResolve = resolve; turnReject = reject; });
			session = {
				thread: codexThread,
				lastToolsHash: newToolsHash,
				pendingFileChanges: new Map(),
				pendingCommandApprovals: new PendingRequestRegistry(),
				pendingFileChangeApprovals: new PendingRequestRegistry(),
				pendingToolCalls: new PendingRequestRegistry(),
				turnActive: false,
				turnDone,
				turnResolve,
				turnReject,
			};
			this._sessions.set(codexThread.id, session);
		}

		// Start a new turn
		session.turnActive = true;
		session.pendingFileChanges.clear();

		const ts = conn.subscribe(codexThread.id);

		// ── Agent delta ──
		ts.on('item/agentMessage/delta', (p: AgentMessageDeltaNotification) => { stream.markdown(p.delta); });

		// ── Turn lifecycle ──
		ts.on('turn/completed', (p: TurnCompletedNotification) => {
			session!.turnActive = false;
			session!.currentAppTurnId = undefined;
			// Unpark any approvals that were never resolved so codex doesn't block.
			session!.pendingCommandApprovals.denyAll('cancel');
			session!.pendingFileChangeApprovals.denyAll('cancel');
			if (p.turn.status === 'failed') {
				const errMsg = p.turn.error?.message ?? 'Turn failed without error details';
				stream.markdown(`\n\n❌ **Error:** ${errMsg}\n`);
				session!.turnReject(new Error(errMsg));
				return;
			}
			session!.turnResolve();
		});

		// ── Reasoning ──
		let thinkingOpen = false;
		ts.on('item/reasoning/summaryPartAdded', () => {
			thinkingOpen = true;
			stream.thinkingProgress!({ id: 'reasoning', text: 'Thinking…' });
		});
		ts.on('item/reasoning/summaryTextDelta', (p: ReasoningSummaryTextDeltaNotification) => {
			if (!thinkingOpen) { stream.thinkingProgress!({ id: 'reasoning', text: 'Thinking…' }); thinkingOpen = true; }
			stream.thinkingProgress!({ id: p.itemId, text: p.delta });
		});
		ts.on('item/reasoning/textDelta', (p: ReasoningTextDeltaNotification) => {
			if (!thinkingOpen) { stream.thinkingProgress!({ id: 'reasoning', text: 'Thinking…' }); thinkingOpen = true; }
			stream.thinkingProgress!({ id: p.itemId, text: p.delta });
		});

		let progressLabel = '';
		const setProgress = (label: string) => {
			if (label !== progressLabel) { progressLabel = label; stream.progress(label); }
		};

		// ── Tool lifecycle ──
		ts.on('item/started', (p: ItemStartedNotification) => {
			const item = p.item;
			log('item/started', item.type, item.id.slice(0, 13));
			if (item.type === 'commandExecution') {
				const cmd = item.command || item.commandActions?.map(a => a.command).join(' | ') || 'command';
				setProgress(`Running ${cmd.slice(0, 80)}`);
			} else if (item.type === 'fileChange') {
				session!.pendingFileChanges.set(item.id, item.changes);
				const diffs = item.changes.map(c => {
					const kind = c.kind.type === 'update' && (c.kind as { move_path?: string }).move_path
						? `rename from ${(c.kind as { move_path?: string }).move_path}`
						: c.kind.type;
					return `### ${kind}: \`${c.path}\`\n\`\`\`diff\n${c.diff}\n\`\`\``;
				});
				stream.markdown(diffs.join('\n\n') + '\n');
				setProgress('Applying file changes…');
			} else if (item.type === 'webSearch') {
				setProgress(`Searching ${item.query || 'web'}…`);
			} else if (item.type === 'mcpToolCall') {
				setProgress(`Calling ${item.server}.${item.tool}…`);
			} else if (item.type === 'dynamicToolCall') {
				const name = item.namespace ? `${item.namespace}.${item.tool}` : item.tool;
				setProgress(`Calling ${name}…`);
			}
		});

		ts.on('item/completed', (p: ItemCompletedNotification) => {
			const item = p.item;
			if (item.type === 'commandExecution') {
				if (outputBlockOpen) { outputBlockOpen = false; stream.markdown('\n```\n'); }
				const ok = item.status === 'completed' && (item.exitCode === 0 || item.exitCode === null);
				setProgress(ok ? 'Continuing…' : 'Tool failed');
			} else if (item.type === 'fileChange') {
				setProgress('Continuing…');
				session!.pendingFileChanges.delete(item.id);
			} else if (item.type === 'mcpToolCall') {
				setProgress('Continuing…');
			} else if (item.type === 'dynamicToolCall') {
				setProgress('Continuing…');
			} else if (item.type === 'reasoning') {
				thinkingOpen = false;
			} else if (item.type === 'webSearch') {
				setProgress('Continuing…');
			}
		});

		// ── Command output streaming ──
		let outputBlockOpen = false;
		ts.on('item/commandExecution/outputDelta', (p: CommandExecutionOutputDeltaNotification) => {
			if (!outputBlockOpen) { outputBlockOpen = true; stream.markdown('\n```\n'); }
			stream.markdown(p.delta);
		});
		ts.on('item/fileChange/patchUpdated', (p: FileChangePatchUpdatedNotification) => { session!.pendingFileChanges.set(p.itemId, p.changes); });
		ts.on('item/mcpToolCall/progress', () => {});
		ts.on('thread/tokenUsage/updated', (p: ThreadTokenUsageUpdatedNotification) => { if (p.tokenUsage.last) { log('token usage', p.tokenUsage.last); } });
		ts.on('error', (err: Error) => {
			session!.turnActive = false;
			session!.pendingCommandApprovals.denyAll('cancel');
			session!.pendingFileChangeApprovals.denyAll('cancel');
			session!.pendingToolCalls.rejectAll(err);
			session!.turnReject(err);
		});
		conn.on('error', (err: Error) => {
			session!.turnActive = false;
			session!.pendingCommandApprovals.denyAll('cancel');
			session!.pendingFileChangeApprovals.denyAll('cancel');
			session!.pendingToolCalls.rejectAll(err);
			session!.turnReject(err);
		});

		// ── Requests (approval + dynamic tool calls) ──
		ts.on('request', (req: unknown) => { void this._onRequest(request, stream, token, conn, session!, req); });

		const cancelSub = token.onCancellationRequested(() => {
			session!.turnActive = false;
			session!.pendingCommandApprovals.denyAll('cancel');
			session!.pendingFileChangeApprovals.denyAll('cancel');
			session!.pendingToolCalls.rejectAll(new Error('Request cancelled'));
			session!.turnReject(new Error('Request cancelled'));
		});

		session.lastToolsHash = newToolsHash;
		log('starting turn', { prompt: request.prompt.slice(0, 120), threadId: codexThread.id, modelId: request.model.id });
		try {
			await conn.startTurn({ threadId: codexThread.id, input: [{ type: 'text', text: request.prompt }], model: request.model.id, approvalPolicy: 'untrusted' });
			await session.turnDone;
		} finally {
			ts.removeAllListeners();
			conn.removeAllListeners('error');
			cancelSub.dispose();
		}

		return { metadata: { threadId: codexThread.id } };
	}

	private async _onRequest(
		request: vscode.ChatRequest, stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken, conn: AppServerConnection,
		session: SessionState, r: unknown,
	): Promise<void> {
		const msg = r as { method: string; id: string | number; params: Record<string, unknown> };
		if (!msg?.method) { return; }

		if (msg.method.includes('requestApproval')) {
			await new Promise<void>(resolve => setImmediate(resolve));

			if (msg.method === 'item/commandExecution/requestApproval') {
				await this._approveCommand(request, stream, token, conn, msg.id, session, msg.params as unknown as CommandExecutionRequestApprovalParams);
			} else if (msg.method === 'item/fileChange/requestApproval') {
				await this._approveFileChange(request, stream, token, conn, msg.id, session, msg.params as unknown as FileChangeRequestApprovalParams);
			} else {
				conn.respondToApproval(msg.id, 'accept');
			}
		} else if (msg.method === 'item/tool/call') {
			const p = msg.params as unknown as DynamicToolCallParams;
			void this._handleToolCall(request, token, conn, msg.id, session, p);
		}
	}

	private async _approveCommand(
		request: vscode.ChatRequest, stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken, conn: AppServerConnection,
		id: string | number, session: SessionState, p: CommandExecutionRequestApprovalParams,
	): Promise<void> {
		stream.progress('Waiting for approval...');
		const cmd = p.command ?? p.commandActions?.map(a => a.command).join(' ') ?? null;
		const lines: string[] = [];
		if (cmd) { lines.push(`**Command:** \`${cmd}\``); }
		if (p.cwd) { lines.push(`**Directory:** ${p.cwd}`); }
		if (p.reason) { lines.push(`**Reason:** ${p.reason}`); }

		const key = String(id);
		// Park a deferred — on disconnect/cancel, denyAll resolves it so
		// we have a clean exit. We don't await the deferred; it's purely
		// for teardown safety.
		session.pendingCommandApprovals.register(key);

		try {
			const r = await vscode.lm.invokeTool('vscode_get_confirmation', {
				input: { title: 'Allow command execution?', message: lines.join('\n\n'), confirmationType: 'basic' },
				toolInvocationToken: request.toolInvocationToken,
			}, token);
			const v = (r.content.at(0) as { value?: unknown } | undefined)?.value;
			const decision: ApprovalDecision = typeof v === 'string' && v.toLowerCase() === 'yes' ? 'accept' : 'cancel';
			conn.respondToApproval(id, decision);
			session.pendingCommandApprovals.respond(key, decision);
		} catch {
			// Prompt failed (cancelled, disconnected, etc.) — denyAll may have
			// already resolved the deferred, but respond to the RPC either way.
			try { conn.respondToApproval(id, 'cancel'); } catch { /* connection dead */ }
			session.pendingCommandApprovals.respond(key, 'cancel');
		}
	}

	private async _approveFileChange(
		request: vscode.ChatRequest, stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken, conn: AppServerConnection,
		id: string | number, session: SessionState, p: FileChangeRequestApprovalParams,
	): Promise<void> {
		stream.progress('Waiting for approval...');
		const lines: string[] = [];
		if (p.grantRoot) { lines.push(`**Root:** ${p.grantRoot}`); }
		if (p.reason) { lines.push(`**Reason:** ${p.reason}`); }

		const key = String(id);
		session.pendingFileChangeApprovals.register(key);

		try {
			const r = await vscode.lm.invokeTool('vscode_get_confirmation', {
				input: { title: 'Allow file changes?', message: lines.join('\n\n') || 'Codex wants to modify files.', confirmationType: 'basic' },
				toolInvocationToken: request.toolInvocationToken,
			}, token);
			const v = (r.content.at(0) as { value?: unknown } | undefined)?.value;
			const decision: ApprovalDecision = typeof v === 'string' && v.toLowerCase() === 'yes' ? 'accept' : 'cancel';
			conn.respondToApproval(id, decision);
			session.pendingFileChangeApprovals.respond(key, decision);
		} catch {
			try { conn.respondToApproval(id, 'cancel'); } catch { /* connection dead */ }
			session.pendingFileChangeApprovals.respond(key, 'cancel');
		}
	}

	dispose(): void {
		// Deny all pending approvals and reject tool calls on teardown.
		for (const session of this._sessions.values()) {
			session.pendingCommandApprovals.denyAll('cancel');
			session.pendingFileChangeApprovals.denyAll('cancel');
			session.pendingToolCalls.rejectAll(new Error('Session disposed'));
			if (session.turnActive) {
				session.turnActive = false;
				session.turnReject(new Error('Session disposed'));
			}
		}
		this._sessions.clear();
		this.nativeConn?.disconnect(); this.nativeConn = null;
		this.proxyConn?.disconnect(); this.proxyConn = null;
	}

	// ── Dynamic tool call dispatch ─────────────────────────────────────────

	/**
	 * Handle an item/tool/call request from the Codex app-server.
	 * Routes the tool invocation to VS Code's `vscode.lm.invokeTool` or a fallback
	 * built-in dispatcher.
	 */
	private async _handleToolCall(
		request: vscode.ChatRequest,
		token: vscode.CancellationToken,
		conn: AppServerConnection,
		requestId: string | number,
		session: SessionState,
		params: DynamicToolCallParams,
	): Promise<void> {
		const toolName = params.tool;

		// Park a deferred so disconnect/cancellation can reject it.
		const resultPromise = session.pendingToolCalls.register(String(requestId));

		// Start the invocation — resultPromise will be resolved by one of:
		// - _invokeTool success / failure below
		// - disconnect → rejectAll → this await throws
		try {
			const result = await this._invokeTool(toolName, params.arguments as Record<string, unknown>, request, token);
			conn.respondToToolCall(requestId, {
				contentItems: [{ type: 'inputText', text: result }],
				success: true,
			});
			session.pendingToolCalls.respond(String(requestId), {
				contentItems: [{ type: 'inputText', text: result }],
				success: true,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Unknown tool error';
			logErr(`tool call "${toolName}" failed`, err);
			conn.respondToToolCall(requestId, {
				contentItems: [{ type: 'inputText', text: `Error: ${message}` }],
				success: false,
			});
			session.pendingToolCalls.respond(String(requestId), {
				contentItems: [{ type: 'inputText', text: `Error: ${message}` }],
				success: false,
			});
		}
	}

	/**
	 * Invoke a VS Code language model tool by name.
	 * Primary path: `vscode.lm.invokeTool()` (proposed `languageModelTool` API).
	 * Fallback: built-in dispatcher for common tools.
	 */
	private async _invokeTool(
		toolName: string,
		args: Record<string, unknown>,
		request: vscode.ChatRequest,
		token: vscode.CancellationToken,
	): Promise<string> {
		// Primary: vscode.lm.invokeTool
		if (typeof (vscode.lm as { invokeTool?: unknown }).invokeTool === 'function') {
			try {
				const result = await vscode.lm.invokeTool(toolName, {
					input: args,
					toolInvocationToken: request.toolInvocationToken,
				}, token);
				// Convert result content to a string for Codex
				const text = result.content
					.map(part => (typeof part === 'object' && part !== null && 'value' in part ? String(part.value) : JSON.stringify(part)))
					.join('\n');
				return text;
			} catch (err) {
				console.warn(`[codex] vscode.lm.invokeTool("${toolName}") failed, trying fallback:`, err);
			}
		}

		// Fallback dispatcher
		return this._fallbackInvokeTool(toolName, args, token);
	}

	/**
	 * Fallback tool dispatcher for when vscode.lm.invokeTool is unavailable.
	 * Handles the most common VS Code built-in tools.
	 */
	private async _fallbackInvokeTool(toolName: string, args: Record<string, unknown>, token: vscode.CancellationToken): Promise<string> {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		const root = workspaceFolders?.[0]?.uri.fsPath;

		switch (toolName) {
			case 'readFile': {
				const filePath = args.filePath as string;
				if (!filePath) { throw new Error('Missing required parameter: filePath'); }
				const uri = vscode.Uri.file(filePath);
				const data = await vscode.workspace.fs.readFile(uri);
				return new TextDecoder().decode(data);
			}
			case 'fileSearch': {
				const pattern = args.pattern as string;
				if (!pattern) { throw new Error('Missing required parameter: pattern'); }
				const base = root ?? process.cwd();
				const files = await vscode.workspace.findFiles(pattern, null, 50, token);
				return files.length > 0 ? files.map(f => vscode.workspace.asRelativePath(f)).join('\n') : 'No files found';
			}
			case 'searchContent': {
				const pattern = args.pattern as string;
				if (!pattern) { throw new Error('Missing required parameter: pattern'); }
				// Fallback: use the vscode proposed API via type cast
				const findTextInFiles = (vscode.workspace as unknown as { findTextInFiles(query: unknown, options: unknown, token: vscode.CancellationToken): Thenable<{ matches: Array<{ uri: vscode.Uri; ranges: Array<{ start: { line: number } }> }> }> }).findTextInFiles;
				if (typeof findTextInFiles !== 'function') {
					return `Content search for "${pattern}" requires vscode.lm.invokeTool`;
				}
				const results = await findTextInFiles(
					{ pattern, isRegExp: false, isCaseSensitive: false },
					{},
					token,
				);
				if (results.matches.length === 0) { return `No matches for "${pattern}"`; }
				return results.matches.slice(0, 20).map((m: { uri: vscode.Uri; ranges: Array<{ start: { line: number } }> }) => {
					const relPath = vscode.workspace.asRelativePath(m.uri);
					return `${relPath}:${m.ranges.map((r: { start: { line: number } }) => r.start.line + 1).join(',')}`;
				}).join('\n');
			}
			case 'listDirectory': {
				const dirPath = (args.directoryPath as string) ?? root ?? process.cwd();
				const uri = vscode.Uri.file(dirPath);
				const entries = await vscode.workspace.fs.readDirectory(uri);
				return entries.map(([name, ft]) => `${ft === 2 ? '📁' : '📄'} ${name}`).join('\n');
			}
			case 'readLints': {
				const paths = args.paths as string | undefined;
				if (paths) {
					const items = vscode.languages.getDiagnostics(vscode.Uri.file(paths));
					if (items.length === 0) { return 'No diagnostics found'; }
					return items.slice(0, 30).map(d => {
						return `${d.range.start.line + 1}: ${d.message}`;
					}).join('\n');
				}
				const allDiags = vscode.languages.getDiagnostics();
				if (allDiags.length === 0) { return 'No diagnostics found'; }
				return allDiags.slice(0, 30).map(([uri, items]) => {
					const relPath = vscode.workspace.asRelativePath(uri);
					return items.map((d: vscode.Diagnostic) => `${relPath}:${d.range.start.line + 1}: ${d.message}`).join('\n');
				}).join('\n');
			}
			default:
				throw new Error(`Tool "${toolName}" is not available. Use vscode.lm.invokeTool or register a fallback.`);
		}
	}
}

function findMetaInHistory(
	history: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>,
): TurnMetadata | undefined {
	for (let i = history.length - 1; i >= 0; i--) {
		const turn = history[i];
		if ('result' in turn) {
			const meta = (turn as vscode.ChatResponseTurn).result.metadata;
			const threadId = meta?.threadId;
			if (typeof threadId === 'string') {
				return { threadId };
			}
		}
	}
}

/**
 * Compute a deterministic hash from a DynamicToolSpec array for change detection.
 */
function hashTools(tools: DynamicToolSpec[]): string {
	if (!tools.length) {
		return 'empty';
	}
	const normalized = tools
		.map(t => `${t.name}:${JSON.stringify(t.inputSchema)}`)
		.sort()
		.join('|');
	return normalized;
}
