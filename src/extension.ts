import * as vscode from 'vscode';
import { CodexParticipant } from './codexParticipant';
import { CopilotParticipant } from './copilotParticipant';
import { ClaudeParticipant } from './claudeParticipant';
import { ProxyManager } from './proxy/index';
import { DynamicToolManager } from './tools/dynamicToolManager';
import { registerCodexModels } from './codexModelProvider';
import { registerClaudeModels } from './claudeModelProvider';

export function activate(context: vscode.ExtensionContext): void {
	// Register model pickers for agents that expose their own native models
	registerCodexModels(context);
	registerClaudeModels(context);
	// Note: no copilot model provider — the Copilot CLI SDK manages model
	// selection internally via the GitHub Copilot API.

	// Start LM proxy servers (OpenAI Responses + Anthropic Messages)
	const proxyManager = new ProxyManager();
	const proxyReady = proxyManager.start();
	proxyReady.then(info => {
		console.log(`[proxy] responses: ${info.responsesUrl}  messages: ${info.messagesUrl}`);
	});
	context.subscriptions.push({ dispose: () => proxyManager.dispose() });

	// Dynamic tool discovery (vscode.lm.tools → Codex dynamicTools)
	const toolManager = new DynamicToolManager();
	context.subscriptions.push(vscode.commands.registerCommand('codex.clearDynamicToolCache', () => {
		toolManager.clearCache();
		vscode.window.showInformationMessage('Codex: Dynamic tool cache cleared');
	}));

	// ── @codex participant ──────────────────────────────────────────────────
	const codexParticipant = new CodexParticipant(proxyManager, toolManager);
	const codexChat = vscode.chat.createChatParticipant(
		'codex.participant',
		codexParticipant.handleRequest.bind(codexParticipant)
	);
	codexChat.iconPath = new vscode.ThemeIcon('robot');
	context.subscriptions.push(codexChat);
	context.subscriptions.push({ dispose: () => codexParticipant.dispose() });

	// ── @copilot-cli participant ────────────────────────────────────────────
	// @github/copilot-sdk auto-discovers the bundled @github/copilot runtime.
	// baseDirectory is set to the extension's own storage to isolate sessions
	// from VS Code's built-in Copilot CLI agent which uses ~/.copilot.
	const copilotParticipant = new CopilotParticipant(context.globalStorageUri.fsPath);
	const copilotChat = vscode.chat.createChatParticipant(
		'copilot-cli.participant',
		copilotParticipant.handleRequest.bind(copilotParticipant)
	);
	copilotChat.iconPath = new vscode.ThemeIcon('github');
	context.subscriptions.push(copilotChat);
	context.subscriptions.push({ dispose: () => copilotParticipant.dispose() });

	// ── @claude participant ─────────────────────────────────────────────────
	const claudeParticipant = new ClaudeParticipant(proxyManager, context.globalStorageUri.fsPath);
	const claudeChat = vscode.chat.createChatParticipant(
		'claude.participant',
		claudeParticipant.handleRequest.bind(claudeParticipant)
	);
	claudeChat.iconPath = new vscode.ThemeIcon('sparkle');
	context.subscriptions.push(claudeChat);
	context.subscriptions.push({ dispose: () => claudeParticipant.dispose() });
}

export function deactivate(): void { /* nothing to do */ }
