import * as vscode from 'vscode';
import { AppServerThread } from './appServer/thread';
import { resolveBinary } from './appServer/client';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Provider ID used when registering with VS Code's LM system.
 * All models returned by this provider will have `vendor === CLAUDE_PROVIDER_ID`.
 * ClaudeParticipant uses this to route to the app server instead of the proxy.
 */
export const CLAUDE_PROVIDER_ID = 'claude-code';

/**
 * Family assigned to all Claude-native models. Groups them visually in the picker
 * and is used as a secondary routing signal alongside `vendor`.
 */
export const CLAUDE_FAMILY = 'claude-code';

// ─── Provider ─────────────────────────────────────────────────────────────────

/**
 * Language model provider that dynamically fetches available models from the
 * Claude app server via `model/list` JSON-RPC. Each model is tagged with
 * `family: CLAUDE_FAMILY` so they are visually grouped and can be identified
 * for routing by ClaudeParticipant.
 *
 * `provideLanguageModelChatResponse` intentionally throws — these models are
 * picker-only signals. Actual routing is handled by ClaudeParticipant.
 *
 * Model list is cached after the first successful fetch. Call `invalidateCache()`
 * to force a refresh (e.g. when the binary path setting changes).
 */
export class ClaudeModelProvider implements vscode.LanguageModelChatProvider {
	private _cachedModels: vscode.LanguageModelChatInformation[] | null = null;
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	async provideLanguageModelChatInformation(
		_options: unknown,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]> {
		console.log('[claude-provider] provideLanguageModelChatInformation called', { cached: this._cachedModels !== null });

		if (this._cachedModels !== null) {
			console.log('[claude-provider] returning cached models (' + this._cachedModels.length + ')', this._cachedModels.map(m => m.id));
			return this._cachedModels;
		}

		try {
			const rawBinaryPath = vscode.workspace.getConfiguration('claude').get<string>('binaryPath') ?? '';
			const binaryPath = resolveBinary(rawBinaryPath, 'claude');
			console.log('[claude-provider] binary path', { raw: rawBinaryPath, resolved: binaryPath });

			// Use a temporary thread to list models: connect → list → disconnect
			console.log('[claude-provider] connecting to app server...');
			const thread = new AppServerThread({ binaryPath });
			await thread.connect();
			console.log('[claude-provider] connected, listing models...');
			const models = await thread.listModels();
			thread.disconnect();
			console.log('[claude-provider] raw models from app server', JSON.stringify(models));

			this._cachedModels = models.map(m => ({
				id: m.id,
				name: m.displayName ?? m.label ?? m.id,
				family: CLAUDE_FAMILY,
				version: '1',
				maxInputTokens: 200000,
				maxOutputTokens: 65536,
				capabilities: { toolCalling: true, imageInput: false },
				// proposed API — makes models visible in picker immediately
				isUserSelectable: true,
			}));
			console.log('[claude-provider] returning', this._cachedModels.length, 'models:', this._cachedModels.map(m => m.id));
		} catch (err) {
			console.error('[claude-provider] failed to list models — will retry on next call. Error:', String(err));
			// Do NOT cache the empty result — leave _cachedModels as null so VS Code can retry
		}

		return this._cachedModels ?? [];
	}

	provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken
	): Thenable<number> {
		const raw = typeof text === 'string' ? text : JSON.stringify(text);
		return Promise.resolve(Math.ceil(raw.length / 4));
	}

	async provideLanguageModelChatResponse(
		_model: vscode.LanguageModelChatInformation,
		_messages: readonly vscode.LanguageModelChatRequestMessage[],
		_options: unknown,
		_progress: vscode.Progress<unknown>,
		_token: vscode.CancellationToken
	): Promise<void> {
		// Routing is handled by ClaudeParticipant — models are picker-only
		throw new Error('Claude models must be used via the @claude chat participant');
	}

	/**
	 * Invalidate the cached model list and notify VS Code to re-query.
	 * Call when the claude binary path setting changes.
	 */
	invalidateCache(): void {
		this._cachedModels = null;
		this._onDidChange.fire();
	}
}

/**
 * Register Claude model provider with VS Code's LM system.
 * Returns the provider so the caller can call `invalidateCache()` if needed.
 */
export function registerClaudeModels(context: vscode.ExtensionContext): ClaudeModelProvider {
	const provider = new ClaudeModelProvider();
	console.log('[claude-provider] registering with provider ID:', CLAUDE_PROVIDER_ID);
	const disposable = vscode.lm.registerLanguageModelChatProvider(CLAUDE_PROVIDER_ID, provider);
	console.log('[claude-provider] registered successfully');
	context.subscriptions.push(disposable);
	// Invalidate cache when the binary path setting changes
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('claude.binaryPath')) {
				provider.invalidateCache();
			}
		})
	);
	return provider;
}
