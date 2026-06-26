import * as vscode from 'vscode';
import { AppServerThread } from './appServer/thread';
import { resolveBinary } from './appServer/client';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Provider ID used when registering with VS Code's LM system.
 * All models returned by this provider will have `vendor === CODEX_PROVIDER_ID`.
 * CodexParticipant uses this to route to the app server instead of the proxy.
 */
export const CODEX_PROVIDER_ID = 'codex';

/**
 * Family assigned to all Codex-native models. Groups them visually in the picker
 * and is used as a secondary routing signal alongside `vendor`.
 */
export const CODEX_FAMILY = 'codex';

// ─── Provider ─────────────────────────────────────────────────────────────────

/**
 * Language model provider that dynamically fetches available models from the
 * Codex app server via `model/list` JSON-RPC. Each model is tagged with
 * `family: CODEX_FAMILY` so they are visually grouped and can be identified
 * for routing by CodexParticipant.
 *
 * `provideLanguageModelChatResponse` intentionally throws — these models are
 * picker-only signals. Actual routing is handled by CodexParticipant.
 *
 * Model list is cached after the first successful fetch. Call `invalidateCache()`
 * to force a refresh (e.g. when the binary path setting changes).
 */
export class CodexModelProvider implements vscode.LanguageModelChatProvider {
	private _cachedModels: vscode.LanguageModelChatInformation[] | null = null;
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	async provideLanguageModelChatInformation(
		_options: unknown,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]> {
		console.log('[codex-provider] provideLanguageModelChatInformation called', { cached: this._cachedModels !== null });

		if (this._cachedModels !== null) {
			console.log('[codex-provider] returning cached models (' + this._cachedModels.length + ')', this._cachedModels.map(m => m.id));
			return this._cachedModels;
		}

		try {
			const rawBinaryPath = vscode.workspace.getConfiguration('codex').get<string>('binaryPath') ?? '';
			const binaryPath = resolveBinary(rawBinaryPath);
			console.log('[codex-provider] binary path', { raw: rawBinaryPath, resolved: binaryPath });

			// Use a temporary thread to list models: connect → list → disconnect
			console.log('[codex-provider] connecting to app server...');
			const thread = new AppServerThread({ binaryPath });
			await thread.connect();
			console.log('[codex-provider] connected, listing models...');
			const models = await thread.listModels();
			thread.disconnect();
			console.log('[codex-provider] raw models from app server', JSON.stringify(models));

			this._cachedModels = models.map(m => ({
				id: m.id,
				name: m.displayName ?? m.label ?? m.id,
				family: CODEX_FAMILY,
				version: '1',
				maxInputTokens: 200000,
				maxOutputTokens: 65536,
				capabilities: { toolCalling: true, imageInput: false },
				// proposed API — makes models visible in picker immediately
				isUserSelectable: true,
			}));
			console.log('[codex-provider] returning', this._cachedModels.length, 'models:', this._cachedModels.map(m => m.id));
		} catch (err) {
			console.error('[codex-provider] failed to list models — will retry on next call. Error:', String(err));
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
		// Routing is handled by CodexParticipant — models are picker-only
		throw new Error('Codex models must be used via the @codex chat participant');
	}

	/**
	 * Invalidate the cached model list and notify VS Code to re-query.
	 * Call when the codex binary path setting changes.
	 */
	invalidateCache(): void {
		this._cachedModels = null;
		this._onDidChange.fire();
	}
}

/**
 * Register Codex model provider with VS Code's LM system.
 * Returns the provider so the caller can call `invalidateCache()` if needed.
 */
export function registerCodexModels(context: vscode.ExtensionContext): CodexModelProvider {
	const provider = new CodexModelProvider();
	console.log('[codex-provider] registering with provider ID:', CODEX_PROVIDER_ID);
	const disposable = vscode.lm.registerLanguageModelChatProvider(CODEX_PROVIDER_ID, provider);
	console.log('[codex-provider] registered successfully');
	context.subscriptions.push(disposable);
	// Invalidate cache when the binary path setting changes
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('codex.binaryPath')) {
				provider.invalidateCache();
			}
		})
	);
	return provider;
}
