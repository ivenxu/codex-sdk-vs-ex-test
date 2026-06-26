import * as vscode from 'vscode';
import { AppServerThread, Thread } from './appServer/thread';
import { resolveBinary } from './appServer/client';
import { CODEX_PROVIDER_ID } from './codexModelProvider';
import { ProxyManager } from './proxy/index';

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
	/** Which thread was used so the next turn can resume into the right subprocess. */
	routing: 'native' | 'proxy';
}

// v2 protocol — file change patch notification payload
interface FileUpdateChange {
	path: string;
	kind: { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null };
	diff: string;
}

// Server-initiated approval request shape (v2 protocol)
interface CommandAction {
	type: 'read' | 'listFiles' | 'search' | 'unknown';
	command: string;
	[key: string]: unknown;
}

interface ApprovalRequest {
	method: string;
	id: string | number;
	params?: {
		// item/commandExecution/requestApproval
		command?: string | null;
		cwd?: string | null;
		reason?: string | null;
		commandActions?: CommandAction[] | null;
		// item/fileChange/requestApproval — ApplyPatchApprovalParams
		grantRoot?: string | null;
		fileChanges?: Record<string,
			| { type: 'add'; content: string }
			| { type: 'delete'; content: string }
			| { type: 'update'; unified_diff: string; move_path: string | null }
		> | null;
		[key: string]: unknown;
	};
}

/** Parse insertions/deletions from a unified diff string. */
function countDiffStats(diff: string): { insertions: number; deletions: number } {
	let insertions = 0;
	let deletions = 0;
	for (const line of diff.split('\n')) {
		if (line.startsWith('+') && !line.startsWith('+++')) { insertions++; }
		if (line.startsWith('-') && !line.startsWith('---')) { deletions++; }
	}
	return { insertions, deletions };
}

/** Apply a unified diff to original text and return the new content. */
function applyUnifiedDiff(original: string, diff: string): string {
	if (!diff.trim()) { return original; }
	const originalLines = original.split('\n');
	const result: string[] = [];
	interface Hunk { oldStart: number; lines: string[] }
	const hunks: Hunk[] = [];
	let currentHunk: Hunk | null = null;
	for (const line of diff.split('\n')) {
		if (line.startsWith('@@')) {
			const m = line.match(/@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
			if (m) { currentHunk = { oldStart: parseInt(m[1]) - 1, lines: [] }; hunks.push(currentHunk); }
		} else if (currentHunk && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-'))) {
			currentHunk.lines.push(line);
		}
	}
	if (hunks.length === 0) { return original; }
	let origIdx = 0;
	for (const hunk of hunks) {
		while (origIdx < hunk.oldStart) { result.push(originalLines[origIdx++]); }
		for (const line of hunk.lines) {
			if (line.startsWith('+')) { result.push(line.slice(1)); }
			else if (line.startsWith('-')) { origIdx++; }
			else { result.push(line.slice(1)); origIdx++; }
		}
	}
	while (origIdx < originalLines.length) { result.push(originalLines[origIdx++]); }
	return result.join('\n');
}

/** Extract the added lines from a diff that creates a new file. */
function extractAddedContent(diff: string): string {
	return diff.split('\n')
		.filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1))
		.join('\n');
}

// ─── Participant ────────────────────────────────────────────────────────────────

/**
 * Chat participant that bridges VS Code Chat to a CodexAppServer process.
 *
 * Session design
 * ──────────────
 * One AppServerThread instance is shared for the lifetime of the extension.
 * Each VS Code chat "conversation" maps to one Codex thread, identified by
 * `ChatResult.metadata.threadId` stored at the end of every turn.
 *
 * On the next turn, `handleRequest` scans `context.history` backwards for
 * the most recent ChatResponseTurn that carries `result.metadata.threadId`,
 * then calls `thread.resumeThread()` to re-attach to that Codex session.
 * If resume fails (e.g. process was restarted), it falls back to a new thread.
 *
 * Approval design
 * ───────────────
 * When the CodexAppServer sends a server-initiated `requestApproval` JSON-RPC
 * request, we call `lm.invokeTool('codex.approval', ...)` which shows an
 * inline confirmation card in the chat UI. The `invoke` callback resolves when
 * the user clicks "Continue" and rejects when they click "Cancel". We forward
 * the decision back to the subprocess via `respondToApproval()`.
 */
export class CodexParticipant {
	/** Thread for Codex-native OpenAI models (o4-mini, o3, gpt-4.1, …). */
	private nativeThread: AppServerThread | null = null;
	/** Thread for VS Code models routed via the responses proxy. */
	private proxyThread: AppServerThread | null = null;
	/** Patch changes accumulated by itemId before a fileChange approval request arrives. */
	private pendingFileChanges = new Map<string, FileUpdateChange[]>();

	constructor(private readonly proxyManager: ProxyManager) {}

	async handleRequest(
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<vscode.ChatResult> {
		// ── 0. Determine routing based on selected model ──────────────────────
		const routing: 'native' | 'proxy' = request.model.vendor === CODEX_PROVIDER_ID ? 'native' : 'proxy';
		log('routing', { modelId: request.model.id, routing });

		// ── 1. Ensure AppServerThread is connected ────────────────────────────
		const binaryPath = resolveBinary(
			vscode.workspace.getConfiguration('codex').get<string>('binaryPath') ?? ''
		);
		log('binary resolved', binaryPath);

		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

		if (routing === 'native') {
			if (!this.nativeThread) {
				log('creating native AppServerThread', { binaryPath, cwd });
				this.nativeThread = new AppServerThread({
					binaryPath,
					cwd,
					model: request.model.id,
					approvalPolicy: 'untrusted',
					sandbox: 'workspace-write',
				});
			}
		} else {
			if (!this.proxyThread) {
				const info = this.proxyManager.info;
				log('creating proxy AppServerThread', { binaryPath, cwd, responsesUrl: info.responsesUrl });
				this.proxyThread = new AppServerThread({
					binaryPath,
					cwd,
					model: request.model.id,
					approvalPolicy: 'untrusted',
					sandbox: 'workspace-write',
					proxyBaseUrl: info.responsesUrl,
					proxyApiKey: info.responsesNonce,
				});
			}
		}

		const activeThread = routing === 'native' ? this.nativeThread! : this.proxyThread!;

		if (!activeThread.isConnected()) {
			log('connecting to app-server...');
			stream.progress('Connecting to Codex...');
			await activeThread.connect();
			log('app-server connected');
		} else {
			log('app-server already connected');
		}

		// ── 2. Session lookup: find threadId from this conversation's history ─
		const savedMeta = findMetaInHistory(context.history);
		// Only resume if the routing mode matches — native and proxy are different subprocesses
		const savedThreadId = savedMeta?.routing === routing ? savedMeta.threadId : undefined;
		log('session lookup', { savedThreadId, routing, historyLength: context.history.length });
		let codexThread: Thread;

		if (savedThreadId) {
			log('resuming thread', savedThreadId);
			stream.progress('Resuming session...');
			try {
				codexThread = await activeThread.resumeThread(savedThreadId);
				log('thread resumed', codexThread.id);
			} catch (err) {
				// Thread may have expired; fall back to a fresh one
				logErr('resume failed, starting new thread', err);
				stream.progress('Previous session expired, starting new session...');
				codexThread = await activeThread.startThread();
				log('new thread started', codexThread.id);
			}
		} else {
			log('no saved thread, starting new thread');
			stream.progress('Starting new session...');
			codexThread = await activeThread.startThread();
			log('new thread started', codexThread.id);
		}

		// ── 3. Prepare per-turn completion promise ───────────────────────────
		// Set this up BEFORE registering listeners so we don't miss 'turn/completed'.
		let completionResolve!: () => void;
		let completionReject!: (err: Error) => void;
		const completionPromise = new Promise<void>((resolve, reject) => {
			completionResolve = resolve;
			completionReject = reject;
		});

		// ── 4. Register per-turn event listeners ────────────────────────────
		const onDelta = (params: unknown) => {
			const p = params as { delta?: string } | undefined;
			if (p?.delta) {
				log('delta', JSON.stringify(p.delta).slice(0, 80));
				stream.markdown(p.delta);
			}
		};

		const onTurnCompleted = (params: unknown) => {
			log('turn/completed', params);
			completionResolve();
		};

		const onError = (err: Error) => {
			logErr('thread error', err);
			completionReject(err);
		};

		const onCommandStarted = (params: unknown) => {
			const p = params as { command?: string } | undefined;
			const cmd = p?.command ?? 'command';
			log('item/commandExecution/started', cmd);
			stream.progress(`Running: ${typeof cmd === 'string' ? cmd : JSON.stringify(cmd)}`);
		};

		const onItemStarted = (params: unknown) => {
			// Cache fileChange items as soon as they start — the item already carries
			// the full changes list at this point (per the official protocol docs).
			// This is keyed by item.id which matches itemId in the approval request.
			const p = params as { item?: { type?: string; id?: string; changes?: FileUpdateChange[] } } | undefined;
			if (p?.item?.type === 'fileChange' && p.item.id && Array.isArray(p.item.changes)) {
				const changes = p.item.changes;
				log('item/started (fileChange)', { itemId: p.item.id, files: changes.map(c => c.path) });
				this.pendingFileChanges.set(p.item.id, changes);
				// Emit a change summary immediately from the notification data so the
				// user sees file paths + line counts before the approval dialog appears.
				const fileLines = changes.map(c => {
					const stats = countDiffStats(c.diff);
					const icon = c.kind.type === 'add' ? '🟢' : c.kind.type === 'delete' ? '🔴' : '🟡';
					const action = c.kind.type === 'add' ? 'add' : c.kind.type === 'delete' ? 'delete' : 'update';
					// For add, diff is empty at item/started time — content arrives later with the approval.
					// Show '(new file)' instead of '(+0 -0)'; same for delete with no parsed lines.
					let countsStr: string;
					if (c.kind.type === 'add' && stats.insertions === 0) {
						countsStr = ' (new file)';
					} else if (c.kind.type === 'delete' && stats.deletions === 0) {
						countsStr = ' (deleted)';
					} else {
						countsStr = (stats.insertions > 0 || stats.deletions > 0) ? ` (+${stats.insertions} -${stats.deletions})` : '';
					}
					return `${icon} \`${c.path}\` (${action})${countsStr}`;
				});
				stream.markdown(`**Proposed changes:**\n${fileLines.join('  \n')}\n\n`);
			}
		};

		const onGuardianCompleted = (params: unknown) => {
			const p = params as { review?: { status?: string; riskLevel?: string; rationale?: string } } | undefined;
			log('item/autoApprovalReview/completed (guardian decision)', p?.review);
		};

		const onApprovalRequest = async (req: unknown) => {
			const r = req as ApprovalRequest;
			if (!r?.method?.includes('requestApproval')) { return; }

			log('approval request received', { method: r.method, id: r.id, params: r.params });
			stream.progress('Waiting for your approval...');

			// Yield to the event loop so any patch notifications already in the line
			// reader's buffer (item/fileChangePatchUpdated) are processed before we
			// build the dialog message.
			await new Promise<void>(resolve => setImmediate(resolve));

			// Build title and markdown message for the inline confirmation card
			let title = 'Codex Approval Request';
			const lines: string[] = [];
			if (r.method === 'item/commandExecution/requestApproval') {
				title = 'Allow command execution?';
				// `command` can be null; fall back to commandActions[].command
				const cmd = r.params?.command
					?? r.params?.commandActions?.map(a => a.command).join(' ')
					?? null;
				if (cmd) { lines.push(`**Command:** \`${cmd}\``); }
				if (r.params?.cwd) { lines.push(`**Directory:** ${r.params.cwd}`); }
			} else if (r.method === 'item/fileChange/requestApproval') {
				const itemId = r.params?.itemId as string | undefined;
				const patches = itemId ? this.pendingFileChanges.get(itemId) : undefined;
				if (patches && patches.length > 0) {
					const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
					const uris = patches.map(c =>
						c.path.startsWith('/')
							? vscode.Uri.file(c.path)
							: workspaceFolder
								? vscode.Uri.joinPath(workspaceFolder.uri, c.path)
								: vscode.Uri.file(c.path)
					);
					// Use stream.externalEdit — same pattern as flowEngine.ts.
					// VS Code snapshots each file before the callback runs, then after,
					// and renders a persistent "file change box" in the chat that the
					// user can Accept or Reject at any time after the turn completes.
					type ExternalEditStream = { externalEdit: (uris: vscode.Uri[], cb: () => Promise<void>) => Promise<string> };
					const extStream = stream as unknown as ExternalEditStream;
					if (typeof extStream.externalEdit === 'function') {
						try {
							await extStream.externalEdit(uris, async () => {
								// Prefer the typed fileChanges payload from the approval request
								// (has full content for add/delete, proper unified_diff for update)
								// over the potentially-empty diff from item/started.
								const fc = r.params?.fileChanges;
								for (let i = 0; i < patches.length; i++) {
									const c = patches[i];
									const uri = uris[i];
									const typedChange = fc?.[c.path];
									try {
										if (c.kind.type === 'add') {
											const content = typedChange?.type === 'add'
												? typedChange.content
												: extractAddedContent(c.diff);
											await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
										} else if (c.kind.type === 'delete') {
											await vscode.workspace.fs.delete(uri, { useTrash: false });
										} else {
											const bytes = await vscode.workspace.fs.readFile(uri);
											const diff = typedChange?.type === 'update'
												? typedChange.unified_diff
												: c.diff;
											const newContent = applyUnifiedDiff(Buffer.from(bytes).toString('utf8'), diff);
											await vscode.workspace.fs.writeFile(uri, Buffer.from(newContent, 'utf8'));
										}
										log('externalEdit: wrote', c.kind.type, c.path);
									} catch (e) {
										log('externalEdit: failed for', c.path, String(e));
									}
								}
							});
							// We applied the changes ourselves — tell codex to accept so its
							// internal state stays consistent (it may write the same bytes again,
							// which is idempotent).
							log('externalEdit completed, accepting codex approval', r.id);
						thread.respondToApproval(r.id, 'accept');
					} catch (err) {
						log('externalEdit failed, cancelling codex approval', r.id, String(err));
						thread.respondToApproval(r.id, 'cancel');
						}
					} else {
						// Fallback when externalEdit is not available: auto-accept silently.
						log('externalEdit not available, auto-accepting', r.id);
						stream.progress('Applying file changes...');
					thread.respondToApproval(r.id, 'accept');
					}
					return;
				} else if (r.params?.grantRoot) {
					lines.push(`**Root:** ${r.params.grantRoot}`);
				}
			} else {
				lines.push(`**Operation:** \`${r.method}\``);
			}
			if (r.params?.reason) { lines.push(`**Reason:** ${r.params.reason}`); }
			// Fallback: dump non-housekeeping params as a code block so the user
			// always sees the raw operation details (e.g. file changes with no reason/grantRoot).
			if (lines.length === 0 && r.params) {
				const stripped = Object.fromEntries(
					Object.entries(r.params).filter(([k]) => !['threadId', 'turnId', 'itemId', 'startedAtMs', 'approvalId'].includes(k))
				);
				lines.push(
					Object.keys(stripped).length > 0
						? `\`\`\`json\n${JSON.stringify(stripped, null, 2)}\n\`\`\``
						: `**Operation:** \`${r.method}\``
				);
			}
			const message = lines.join('\n\n');

			// Use default Allow/Cancel buttons — cleaner VS Code styling, no custom
			// button mapping needed.  Returns 'yes' on Allow, throws on Cancel/dismiss.
			try {
				const result = await vscode.lm.invokeTool(
					'vscode_get_confirmation',
					{
						input: { title, message, confirmationType: 'basic' },
						toolInvocationToken: request.toolInvocationToken,
					},
					token
				);
				const firstPart = result.content.at(0);
				const rawValue: unknown = firstPart != null && typeof firstPart === 'object' && 'value' in firstPart ? (firstPart as { value: unknown }).value : undefined;
				log('invokeTool result', { rawValue });
				const decision: 'accept' | 'cancel' = typeof rawValue === 'string' && rawValue.toLowerCase() === 'yes' ? 'accept' : 'cancel';
				log('approval decision:', decision, 'id:', r.id);
				thread.respondToApproval(r.id, decision);
			} catch (err) {
				log('approval decision: cancel (dismissed or error)', r.id, String(err));
				thread.respondToApproval(r.id, 'cancel');
			}
		};

		const thread = activeThread;
		thread.on('item/agentMessage/delta', onDelta);
		thread.on('turn/completed', onTurnCompleted);
		thread.on('error', onError);
		thread.on('request', onApprovalRequest);
		thread.on('item/commandExecution/started', onCommandStarted);
		thread.on('item/started', onItemStarted);
		thread.on('item/autoApprovalReview/completed', onGuardianCompleted);

		// Forward cancellation
		const cancellationSubscription = token.onCancellationRequested(() => {
			completionReject(new Error('Request cancelled'));
		});

		const permissionLevel = (request as unknown as { permissionLevel?: string }).permissionLevel;
		const modelConfig = (request as unknown as { modelConfiguration?: Record<string, unknown> }).modelConfiguration;
		const reasoningEffort = modelConfig?.['reasoningEffort'] as string | undefined;
		const contextSize = modelConfig?.['contextSize'] as number | undefined;
		log('starting turn', { prompt: request.prompt.slice(0, 120), threadId: codexThread.id, permissionLevel, reasoningEffort, contextSize, modelId: request.model.id, modelFamily: request.model.family });
		stream.markdown(`> **Permission level:** \`${permissionLevel ?? 'undefined'}\` | **Reasoning effort:** \`${reasoningEffort ?? 'undefined'}\` | **Context size:** \`${contextSize ?? 'undefined'}\`\n> **Model:** \`${request.model.id}\` (${request.model.family})\n\n`);
		try {
			await thread.startTurn(request.prompt);
			log('turn/start ack received, waiting for turn/completed...');
			await completionPromise;
			log('turn finished successfully');
		} finally {
			// Always remove per-turn listeners to prevent accumulation across turns
			thread.removeListener('item/agentMessage/delta', onDelta);
			thread.removeListener('turn/completed', onTurnCompleted);
			thread.removeListener('error', onError);
			thread.removeListener('request', onApprovalRequest);
			thread.removeListener('item/commandExecution/started', onCommandStarted);
			thread.removeListener('item/started', onItemStarted);
			thread.removeListener('item/autoApprovalReview/completed', onGuardianCompleted);
			this.pendingFileChanges.clear();
			cancellationSubscription.dispose();
		}

		// ── 5. Persist thread id and routing for the next turn ───────────────
		const metadata: TurnMetadata = { threadId: codexThread.id, routing };
		log('returning metadata for next turn', metadata);
		return { metadata };
	}

	dispose(): void {
		this.nativeThread?.disconnect();
		this.nativeThread = null;
		this.proxyThread?.disconnect();
		this.proxyThread = null;
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Scan the conversation history backwards for the most recent ChatResponseTurn
 * that carries `threadId` and `routing` in its result metadata.
 */
function findMetaInHistory(
	history: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>
): TurnMetadata | undefined {
	for (let i = history.length - 1; i >= 0; i--) {
		const turn = history[i];
		if ('result' in turn) {
			const meta = (turn as vscode.ChatResponseTurn).result.metadata;
			const threadId = meta?.['threadId'];
			const routing = meta?.['routing'];
			if (typeof threadId === 'string' && (routing === 'native' || routing === 'proxy')) {
				return { threadId, routing };
			}
		}
	}
	return undefined;
}
