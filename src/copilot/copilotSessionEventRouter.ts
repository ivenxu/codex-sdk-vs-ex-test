/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Routes GitHub Copilot CLI SDK session events to VS Code Chat stream actions.
 *
 * The Copilot SDK emits ~80 structured `SessionEvent` types. This pure function
 * maps the ones we care about — assistant text, reasoning/thinking, tool
 * lifecycle, skills, subagents, and usage — onto `vscode.ChatResponseStream`
 * calls, and resolves the turn on `session.idle`. Unknown event types are
 * ignored so the router stays forward-compatible with the full event union.
 */

import * as vscode from 'vscode';
import type { SessionEvent } from '@github/copilot-sdk';

function log(msg: string, ...args: unknown[]): void {
	console.log(`[copilot:router] ${msg}`, ...args);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	/** Current context-window token count (from session.usage_info). */
	contextTokens?: number;
	/** Context-window token limit (from session.usage_info). */
	contextLimit?: number;
}

export interface RouterState {
	/** Id of the reasoning block currently being streamed, or null. */
	currentReasoningId: string | null;
	/** Reasoning IDs that have already received delta events (used to skip the final full-text event). */
	reasoningIdsWithDeltas: Set<string>;
	/** Active tool calls: toolCallId → toolName. */
	activeToolCalls: Map<string, string>;
	/** Cumulative token usage for this turn. */
	usage: TokenUsage;
	/** Model id reported by the assistant, if any. */
	modelId: string | null;
	/** Whether the turn reached idle. */
	completed: boolean;
}

export function createInitialRouterState(): RouterState {
	return {
		currentReasoningId: null,
		reasoningIdsWithDeltas: new Set(),
		activeToolCalls: new Map(),
		usage: { inputTokens: 0, outputTokens: 0 },
		modelId: null,
		completed: false,
	};
}

// ─── Router ───────────────────────────────────────────────────────────────────

/**
 * Route a single SDK session event to the chat stream, mutating and returning
 * the router state. `onIdle` is invoked once when the session becomes idle.
 */
export function routeSessionEvent(
	event: SessionEvent,
	stream: vscode.ChatResponseStream,
	state: RouterState,
	onIdle: () => void,
): RouterState {
	switch (event.type) {
		case 'assistant.reasoning': {
			// This event fires AFTER all deltas with the complete reasoning text.
			// Only display it when no deltas were received (non-streaming fallback).
			if (!state.reasoningIdsWithDeltas.has(event.data.reasoningId)) {
				const text = event.data.content ?? '';
				if (text) {
					stream.thinkingProgress!({ id: event.data.reasoningId, text });
				}
			}
			state.currentReasoningId = null;
			return state;
		}
		case 'assistant.reasoning_delta': {
			const id = event.data.reasoningId;
			if (!state.reasoningIdsWithDeltas.has(id)) {
				// Open the thinking block on the first delta.
				state.reasoningIdsWithDeltas.add(id);
				stream.thinkingProgress!({ id, text: 'Thinking…\n' });
			}
			state.currentReasoningId = id;
			const delta = event.data.deltaContent;
			if (delta) {
				stream.thinkingProgress!({ id, text: delta });
			}
			return state;
		}
		case 'assistant.message_delta': {
			const text = event.data.deltaContent;
			if (text) {
				stream.markdown(text);
			}
			return state;
		}
		case 'assistant.message': {
			// The final combined message. When deltas streamed it, avoid double
			// output by only emitting when no deltas were seen for this turn.
			if (event.data.model) {
				state.modelId = event.data.model;
			}
			if (typeof event.data.outputTokens === 'number') {
				state.usage.outputTokens = event.data.outputTokens;
			}
			return state;
		}
		case 'tool.execution_start': {
			state.activeToolCalls.set(event.data.toolCallId, event.data.toolName);
			log('tool.execution_start', { toolCallId: event.data.toolCallId.slice(0, 13), toolName: event.data.toolName });
			stream.progress(`Running ${event.data.toolName}…`);
			return state;
		}
		case 'tool.execution_complete': {
			state.activeToolCalls.delete(event.data.toolCallId);
			log('tool.execution_complete', { toolCallId: event.data.toolCallId.slice(0, 13), success: event.data.success });
			if (event.data.success === false && event.data.error) {
				const message = typeof event.data.error === 'string'
					? event.data.error
					: (event.data.error as { message?: string }).message ?? 'tool error';
				stream.markdown(`\n\n> ⚠️ Tool failed: ${message}\n`);
			}
			return state;
		}
		case 'skill.invoked': {
			log('skill.invoked', { name: event.data.name });
			stream.markdown(`\n\n> 🧩 Skill: \`${event.data.name}\`\n`);
			return state;
		}
		case 'subagent.started': {
			log('subagent.started', { agentName: event.data.agentName });
			stream.progress(`Delegating to ${event.data.agentDisplayName}…`);
			return state;
		}
		case 'assistant.usage': {
			if (typeof event.data.inputTokens === 'number') {
				state.usage.inputTokens = event.data.inputTokens;
			}
			if (typeof event.data.outputTokens === 'number') {
				state.usage.outputTokens = event.data.outputTokens;
			}
			if (event.data.model) {
				state.modelId = event.data.model;
			}
			return state;
		}
		case 'session.usage_info': {
			state.usage.contextTokens = event.data.currentTokens;
			state.usage.contextLimit = event.data.tokenLimit;
			return state;
		}
		case 'session.idle': {
			state.completed = true;
			log('session.idle', { inputTokens: state.usage.inputTokens, outputTokens: state.usage.outputTokens, modelId: state.modelId });
			onIdle();
			return state;
		}
		default:
			// Unknown / unhandled event types are ignored.
			return state;
	}
}
