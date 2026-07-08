/**
 * Builds the SDK `Options` object from VS Code extension context.
 *
 * Central factory for constructing `@anthropic-ai/claude-agent-sdk` Options.
 * Does NOT read VS Code config — all parameters are passed explicitly.
 *
 * @module claudeOptionsBuilder
 */

import * as vscode from 'vscode';
import {
	type Options,
	type PermissionMode,
	type CanUseTool,
} from '@anthropic-ai/claude-agent-sdk';
import type { OnElicitation } from '@anthropic-ai/claude-agent-sdk';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProxyInfo {
	messagesUrl: string;
	messagesNonce: string;
}

export interface OptionsBuilderInput {
	/** Proxy info for routing Anthropic Messages API calls */
	proxyInfo: ProxyInfo;
	/** The VS Code chat request (provides model, toolInvocationToken, etc.) */
	request: vscode.ChatRequest;
	/** The cancellation token (for AbortController) */
	token: vscode.CancellationToken;
	/** Saved session ID for resume, or undefined for new session */
	savedSessionId?: string;
	/** Extension storage path (for CLAUDE_CONFIG_DIR isolation) */
	storagePath: string;
	/** Current working directory (from workspace folders) */
	cwd?: string;
	/** SDK PermissionMode — default is 'default' (prompt user for dangerous tools) */
	permissionMode?: PermissionMode;
	/** MCP server configs to pass to the SDK */
	mcpServers?: Record<string, unknown>;
}

// ─── Options Builder ─────────────────────────────────────────────────────────

/**
 * Build the full SDK `Options` object from VS Code extension context.
 *
 * This is the primary factory — all Options should flow through here to
 * ensure consistent configuration across query() and startup() calls.
 */
export function buildClaudeOptions(input: OptionsBuilderInput): Options {
	const cwd = input.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const model = input.request.model.id;
	const permissionMode = input.permissionMode ?? 'default';

	const options: Options = {
		cwd,
		abortController: new AbortController(),
		...(input.savedSessionId ? { resume: input.savedSessionId } : {}),
		env: {
			...process.env,
			ANTHROPIC_BASE_URL: input.proxyInfo.messagesUrl,
			ANTHROPIC_AUTH_TOKEN: input.proxyInfo.messagesNonce,
			// Isolate session storage from VS Code's built-in Claude agent (~/.claude)
			CLAUDE_CONFIG_DIR: input.storagePath,
		},
		// ── Enable stream_event processing ──
		includePartialMessages: true,

		// ── Safety: file checkpointing ──
		enableFileCheckpointing: true,

		// ── Model override ──
		model,

		// ── MCP servers (from caller, not config) ──
		...(input.mcpServers ? { mcpServers: input.mcpServers as Options['mcpServers'] } : {}),

		// ── Permission callback — the sole gate for all tool approvals ──
		// allowDangerouslySkipPermissions tells the SDK to bypass its own
		// internal permission rules and delegate EVERY decision to canUseTool.
		allowDangerouslySkipPermissions: true,
		canUseTool: makeCanUseTool(input.request, input.token, permissionMode),

		// ── MCP elicitation callback ──
		onElicitation: makeOnElicitation(input.request, input.token),
	};

	return options;
}

// ─── Callback Factories ───────────────────────────────────────────────────────

/**
 * Create the `canUseTool` callback for the SDK.
 *
 * Permission mode affects behavior:
 *   'default'        → prompt user via vscode_get_confirmation
 *   'bypassPermissions' → auto-allow (no prompt)
 *   'dontAsk'        → auto-deny (no prompt)
 *   'acceptEdits'    → auto-allow file edit tools, prompt for others
 */
function makeCanUseTool(
	request: vscode.ChatRequest,
	token: vscode.CancellationToken,
	mode: PermissionMode,
): CanUseTool {
	return async (toolName, _input, _options) => {
		console.log(`[claude] canUseTool: ${toolName} (mode: ${mode})`);

		if (mode === 'bypassPermissions') {
			return { behavior: 'allow' as const };
		}

		if (mode === 'dontAsk') {
			return { behavior: 'deny' as const, message: 'Denied by permission mode (dontAsk)' };
		}

		if (mode === 'acceptEdits' && isFileEditTool(toolName)) {
			return { behavior: 'allow' as const };
		}

		// Default: prompt via VS Code confirmation dialog
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
				token,
			);
			const firstPart = result.content.at(0);
			const rawValue: unknown = firstPart != null && typeof firstPart === 'object' && 'value' in firstPart
				? (firstPart as { value: unknown }).value
				: undefined;
			return typeof rawValue === 'string' && rawValue.toLowerCase() === 'yes'
				? { behavior: 'allow' as const }
				: { behavior: 'deny' as const, message: 'Denied by user' };
		} catch {
			return { behavior: 'deny' as const, message: 'Approval dialog failed' };
		}
	};
}

/**
 * Create the `onElicitation` callback for MCP server elicitation requests.
 */
function makeOnElicitation(
	request: vscode.ChatRequest,
	token: vscode.CancellationToken,
): OnElicitation {
	return async (req) => {
		console.log('[claude] onElicitation', { mode: req.mode });

		try {
			const result = await vscode.lm.invokeTool(
				'vscode_get_confirmation',
				{
					input: {
						title: 'MCP Server Elicitation Request',
						message: req.message ?? 'An MCP server is requesting user input.',
						confirmationType: 'basic',
					},
					toolInvocationToken: request.toolInvocationToken,
				},
				token,
			);
			const firstPart = result.content.at(0);
			const rawValue: unknown = firstPart != null && typeof firstPart === 'object' && 'value' in firstPart
				? (firstPart as { value: unknown }).value
				: undefined;
			const accepted = typeof rawValue === 'string' && rawValue.toLowerCase() === 'yes';

			if (accepted) {
				return { action: 'accept' as const };
			}
			return { action: 'cancel' as const };
		} catch {
			return { action: 'cancel' as const };
		}
	};
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isFileEditTool(toolName: string): boolean {
	return ['Edit', 'FileWrite', 'file_edit', 'FileEdit', 'Write'].includes(toolName);
}
