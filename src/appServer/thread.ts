import { EventEmitter } from 'events';
import { AppServerClient } from './client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ThreadOptions {
	/** Resolved absolute path to the codex binary. Required. */
	binaryPath: string;
	model?: string;
	cwd?: string;
	approvalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted';
	sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
	personality?: 'friendly' | 'pragmatic' | 'none';
	/**
	 * When set, spawns the subprocess with a `vscode-proxy` model provider
	 * configured via `-c` CLI overrides that point at this URL.
	 * The proxy's nonce is used as `OPENAI_API_KEY` in the environment.
	 */
	proxyBaseUrl?: string;
	/** Bearer token (nonce) for the responses proxy. Required when proxyBaseUrl is set. */
	proxyApiKey?: string;
	/**
	 * Wire API protocol for the proxy provider.
	 * - `'responses'` (default): OpenAI Responses API — env key `OPENAI_API_KEY`
	 * - `'messages'`: Anthropic Messages API — env key `ANTHROPIC_API_KEY`
	 */
	proxyWireApi?: 'responses' | 'messages';
}

export interface Thread {
	id: string;
	createdAt?: number;
	modelProvider?: string;
}

/** A single model entry returned by the app server's `model/list` RPC. */
export interface AppServerModel {
	id: string;
	model?: string;
	displayName?: string;
	description?: string;
	label?: string;
	hidden?: boolean;
	supportedReasoningEfforts?: string[];
	serviceTiers?: string[];
	defaultServiceTier?: string;
}

export interface Turn {
	id: string;
	threadId: string;
	status?: string;
}

// ─── AppServerThread ──────────────────────────────────────────────────────────

/**
 * High-level thread + turn lifecycle management over AppServerClient.
 *
 * Usage:
 *   const t = new AppServerThread({ binaryPath });
 *   await t.connect();
 *   await t.startThread();            // or resumeThread(id)
 *   await t.startTurn('hello');       // then listen for notifications
 *   t.respondToApproval(id, 'approved');
 *   t.disconnect();
 *
 * Events forwarded from AppServerClient:
 *   'notification'  — any server notification
 *   'request'       — server-initiated request (approval etc.)
 *   'error'         — error
 *   'stderr'        — subprocess stderr
 *   'exit'          — process exited
 *   '{method}'      — shortcut per notification method
 */
export class AppServerThread extends EventEmitter {
	private readonly client: AppServerClient;
	private currentThread: Thread | null = null;
	private initialized = false;

	constructor(private readonly options: ThreadOptions) {
		super();
		// Build -c overrides and env for proxy mode (same pattern as VS Code agent host)
		let clientEnv: NodeJS.ProcessEnv | undefined;
		let extraArgs: string[] | undefined;
		if (options.proxyBaseUrl) {
			const wireApi = options.proxyWireApi ?? 'responses';
			const envKey = wireApi === 'messages' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
			// API key carries the nonce — Codex/Claude reads it via env_key on the provider config
			clientEnv = { ...process.env, [envKey]: options.proxyApiKey ?? '' };
			const providerOverrides = [
				`model_provider="vscode-proxy"`,
				`model_providers.vscode-proxy.name="VS Code Proxy"`,
				`model_providers.vscode-proxy.base_url="${options.proxyBaseUrl}/v1"`,
				`model_providers.vscode-proxy.wire_api="${wireApi}"`,
				`model_providers.vscode-proxy.env_key="${envKey}"`,
				`model_providers.vscode-proxy.requires_openai_auth=false`,
				`model_providers.vscode-proxy.supports_websockets=false`,
				`features.tool_call_mcp_elicitation=false`,
			];
			extraArgs = providerOverrides.flatMap(kv => ['-c', kv]);
		}
		this.client = new AppServerClient({
			binaryPath: options.binaryPath,
			cwd: options.cwd,
			env: clientEnv,
			extraArgs,
		});

		// Forward all client events
		this.client.on('notification', (notification: unknown) => {
			this.emit('notification', notification);
			const n = notification as { method?: string; params?: unknown };
			if (n.method) {
				this.emit(n.method, n.params);
			}
		});

		this.client.on('request', (request: unknown) => {
			this.emit('request', request);
		});

		this.client.on('error', (error: Error) => {
			this.emit('error', error);
		});

		this.client.on('stderr', (text: string) => {
			this.emit('stderr', text);
		});

		this.client.on('exit', (info: unknown) => {
			this.initialized = false;
			this.currentThread = null;
			this.emit('exit', info);
		});
	}

	// ─── Lifecycle ────────────────────────────────────────────────────────────

	/** Spawn the app-server process and complete the initialize handshake. */
	async connect(): Promise<void> {
		await this.client.start();
		await this.client.initialize({
			name: 'codex_vscode_poc',
			title: 'Codex VS Code POC',
			version: '0.0.1',
		});
		this.initialized = true;
	}

	/** Disconnect and kill the subprocess. */
	disconnect(): void {
		this.client.stop();
		this.currentThread = null;
		this.initialized = false;
	}

	/** Returns true if the subprocess is running and initialized. */
	isConnected(): boolean {
		return this.initialized;
	}

	// ─── Thread management ────────────────────────────────────────────────────

	/** Start a brand-new thread. Sets the active thread. */
	async startThread(): Promise<Thread> {
		this.assertInitialized();

		const params: Record<string, unknown> = {};
		if (this.options.model) { params['model'] = this.options.model; }
		if (this.options.cwd) { params['cwd'] = this.options.cwd; }
		if (this.options.approvalPolicy) { params['approvalPolicy'] = this.options.approvalPolicy; }
		if (this.options.sandbox) { params['sandbox'] = this.options.sandbox; }
		if (this.options.personality) { params['personality'] = this.options.personality; }

		const result = await this.client.request('thread/start', params) as { thread: Thread };
		this.currentThread = result.thread;
		return this.currentThread;
	}

	/** Resume an existing thread by id. Sets the active thread. */
	async resumeThread(threadId: string): Promise<Thread> {
		this.assertInitialized();

		const result = await this.client.request('thread/resume', {
			threadId,
			excludeTurns: true,
		}) as { thread: Thread };

		this.currentThread = result.thread;
		return this.currentThread;
	}

	// ─── Turn management ──────────────────────────────────────────────────────

	/**
	 * Send a user message to start a new turn.
	 * Returns the Turn object. Actual output arrives via notifications:
	 *   'item/agentMessage/delta'  → { delta: string }
	 *   'turn/completed'           → turn finished
	 */
	async startTurn(userInput: string): Promise<Turn> {
		if (!this.currentThread) {
			throw new Error('No active thread. Call startThread() or resumeThread() first.');
		}

		const params: Record<string, unknown> = {
			threadId: this.currentThread.id,
			input: [{ type: 'text', text: userInput }],
		};
		// Re-assert the approval policy on every turn so it is enforced even on
		// resumed threads that may have been created with a different policy.
		if (this.options.approvalPolicy) {
			params['approvalPolicy'] = this.options.approvalPolicy;
		}

		const result = await this.client.request('turn/start', params) as { turn: Turn };
		return result.turn;
	}

	// ─── Model discovery ──────────────────────────────────────────────────────

	/** List models available on this app server instance. */
	async listModels(includeHidden = false): Promise<AppServerModel[]> {
		this.assertInitialized();
		const result = await this.client.request('model/list', { includeHidden }) as { data?: AppServerModel[]; models?: AppServerModel[] };
		return result.data ?? result.models ?? [];
	}

	// ─── Approval ─────────────────────────────────────────────────────────────

	/** Send an approval response for a server-initiated request. */
	respondToApproval(
		requestId: string | number,
		decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
	): void {
		this.client.respond(requestId, { decision });
	}

	// ─── Accessors ────────────────────────────────────────────────────────────

	getCurrentThread(): Thread | null {
		return this.currentThread;
	}

	// ─── Internal ─────────────────────────────────────────────────────────────

	private assertInitialized(): void {
		if (!this.initialized) {
			throw new Error('AppServerThread not initialized. Call connect() first.');
		}
	}
}
