/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'events';
import { AppServerClient } from './client';
import type {
	Thread, Turn,
	ThreadStartParams, ThreadStartResponse,
	ThreadResumeParams, ThreadResumeResponse,
	TurnStartParams, TurnStartResponse,
	DynamicToolSpec, DynamicToolCallParams, DynamicToolCallResponse,
} from '../protocol/types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConnectionOptions {
	binaryPath: string;
	cwd?: string;
	proxyBaseUrl?: string;
	proxyApiKey?: string;
	proxyWireApi?: 'responses' | 'messages';
}

/** Extra connection-level fields exposed to the participant */
export interface ConnectionInfo {
	/** The base URL of the proxy server, if in proxy mode */
	proxyBaseUrl?: string;
}

// ─── AppServerConnection ──────────────────────────────────────────────────────

/**
 * Transport connection to a codex app-server process. One connection handles
 * MANY threads. Per-thread event dispatch is done by inspecting `threadId`
 * on every notification and routing to a private EventEmitter per thread.
 *
 * Each call to `subscribe(threadId)` returns a private `ThreadSession`
 * EventEmitter that only receives events for that thread. Register all your
 * turn listeners on the ThreadSession, NOT on the connection itself.
 */
export class AppServerConnection extends EventEmitter {
	private readonly _client: AppServerClient;
	private readonly _options: ConnectionOptions;
	/** Per-thread private EventEmitters */
	private readonly _threads = new Map<string, EventEmitter>();
	private _connected = false;

	constructor(options: ConnectionOptions) {
		super();

		this._options = options;

		// Build -c overrides and env for proxy mode
		let clientEnv: NodeJS.ProcessEnv | undefined;
		let extraArgs: string[] | undefined;
		if (options.proxyBaseUrl) {
			const wireApi = options.proxyWireApi ?? 'responses';
			const envKey = wireApi === 'messages' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
			clientEnv = { ...process.env, [envKey]: options.proxyApiKey ?? '' };
			const overrides = [
				`model_provider="vscode-proxy"`,
				`model_providers.vscode-proxy.name="VS Code Proxy"`,
				`model_providers.vscode-proxy.base_url="${options.proxyBaseUrl}/v1"`,
				`model_providers.vscode-proxy.wire_api="${wireApi}"`,
				`model_providers.vscode-proxy.env_key="${envKey}"`,
				`model_providers.vscode-proxy.requires_openai_auth=false`,
				`model_providers.vscode-proxy.supports_websockets=false`,
				`features.tool_call_mcp_elicitation=false`,
			];
			extraArgs = overrides.flatMap(kv => ['-c', kv]);
		}

		this._client = new AppServerClient({
			binaryPath: options.binaryPath,
			cwd: options.cwd,
			env: clientEnv,
			extraArgs,
		});

		// ── THE KEY: Per-thread notification dispatch ──
		// Instead of broadcasting to all listeners on `this`, inspect the
		// notification's threadId and route to the correct per-thread emitter.
		this._client.on('notification', (notification: unknown) => {
			const n = notification as { method?: string; params?: { threadId?: string; item?: { type?: string } } };
			const threadId = n.params?.threadId;
			// Log item/started and item/completed for fileChange diagnostics
			if (n.method === 'item/started' || n.method === 'item/completed') {
				console.log(`[app-server] notif: ${n.method} type=${n.params?.item?.type}`, JSON.stringify(n.params).slice(0, 200));
			}

			if (threadId) {
				const session = this._threads.get(threadId);
				if (session) {
					session.emit(n.method!, n.params);
				} else if (n.method?.startsWith('item/')) {
					console.log(`[app-server] WARN: no session for threadId ${threadId}, event ${n.method}`);
				}
			}

			// Also emit generic notification on connection (for connection-level observers)
			this.emit('notification', notification);
		});

		// ── Server-initiated request dispatch (approvals, tool calls) ──
		// These also carry threadId in params
		this._client.on('request', (request: unknown) => {
			const r = request as { method?: string; id: string | number; params?: { threadId?: string } };
			const threadId = r.params?.threadId;
			if (threadId) {
				const session = this._threads.get(threadId);
				if (session) {
					session.emit('request', request);
				}
			}
			// Also emit on connection
			this.emit('request', request);
		});

		// Connection-level events
		this._client.on('error', (err: Error) => this.emit('error', err));
		this._client.on('stderr', (text: string) => this.emit('stderr', text));
		this._client.on('exit', (info: unknown) => {
			this._connected = false;
			this._threads.clear();
			this.emit('exit', info);
		});
	}

	// ─── Lifecycle ────────────────────────────────────────────────────────────

	async connect(): Promise<void> {
		await this._client.start();
		await this._client.initialize({
			name: 'codex_vscode_poc',
			title: 'Codex VS Code POC',
			version: '0.0.1',
		});
		this._connected = true;
	}

	isConnected(): boolean { return this._connected; }

	// ─── Per-Thread Subscription ──────────────────────────────────────────────

	/**
	 * Get or create a private EventEmitter for a thread. All notifications
	 * and requests carrying this threadId will be routed ONLY to this emitter.
	 * Register your per-turn listeners here.
	 */
	subscribe(threadId: string): EventEmitter {
		let session = this._threads.get(threadId);
		if (!session) {
			session = new EventEmitter();
			this._threads.set(threadId, session);
		}
		return session;
	}

	/** Remove a thread's private emitter and all its listeners. */
	unsubscribe(threadId: string): void {
		const session = this._threads.get(threadId);
		if (session) {
			session.removeAllListeners();
			this._threads.delete(threadId);
		}
	}

	// ─── Thread Management ────────────────────────────────────────────────────

	async startThread(params: ThreadStartParams): Promise<Thread> {
		console.log('[app-server] startThread params:', {
			model: params.model,
			cwd: params.cwd,
			approvalPolicy: params.approvalPolicy,
			sandbox: params.sandbox,
			developerInstructions: params.developerInstructions ? params.developerInstructions.substring(0, 100) + '...' : undefined,
			dynamicToolsCount: params.dynamicTools?.length,
		});
		const result = await this._client.request('thread/start', params) as ThreadStartResponse;
		return result.thread;
	}

	async resumeThread(params: ThreadResumeParams): Promise<Thread> {
		const result = await this._client.request('thread/resume', params) as ThreadResumeResponse;
		return result.thread;
	}

	// ─── Turn management ──────────────────────────────────────────────────────

	async startTurn(params: TurnStartParams): Promise<Turn> {
		const result = await this._client.request('turn/start', params) as TurnStartResponse;
		return result.turn;
	}

	// ─── Model Discovery ──────────────────────────────────────────────────────

	async listModels(includeHidden = false): Promise<Array<{ id: string; displayName?: string; label?: string; hidden?: boolean }>> {
		const result = await this._client.request('model/list', { includeHidden }) as { data?: Array<{ id: string; displayName?: string; label?: string; hidden?: boolean }> };
		return result.data ?? [];
	}

	// ─── Approval ─────────────────────────────────────────────────────────────

	respondToApproval(requestId: string | number, decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'): void {
		this._client.respond(requestId, { decision });
	}

	/** Respond to a dynamic tool call request. */
	respondToToolCall(requestId: string | number, response: DynamicToolCallResponse): void {
		this._client.respond(requestId, response);
	}

	// ─── Teardown ─────────────────────────────────────────────────────────────

	disconnect(): void {
		this._client.stop();
		this._threads.clear();
		this._connected = false;
	}
}
