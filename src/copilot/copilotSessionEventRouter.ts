/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Routes GitHub Copilot CLI SDK session events to VS Code Chat stream actions.
 *
 * Event coverage (verified against SDK session-events.d.ts and the VS Code host
 * agent's copilotAgentSession.ts / mapSessionEvents.ts):
 *
 * HANDLED (surfaced to the user or critical for turn lifecycle):
 *   assistant.reasoning / reasoning_delta  → thinkingProgress (streaming thinking)
 *   assistant.message / message_delta      → markdown (streaming response text)
 *   assistant.usage                        → token usage accumulation
 *   tool.execution_start                   → stream.progress (tool badge)
 *   tool.execution_progress                → stream.progress (live progress message)
 *   tool.execution_complete                → surface errors if tool failed
 *   skill.invoked                          → markdown annotation
 *   subagent.started                       → stream.progress
 *   session.usage_info                     → context token counts
 *   session.error                          → surface error to user + unblock turn
 *   session.warning                        → surface warning to user (incl. mcp category)
 *   session.mcp_servers_loaded             → log per-server status; progress on failures
 *   session.mcp_server_status_changed      → log status changes; progress on failures
 *   session.idle                           → resolve turn (guarded by hasOutput)
 *   session.shutdown (error)               → surface crash + resolve turn
 *
 * IGNORED (host agent also ignores or only logs at trace):
 *   tool.execution_partial_result  — partial tool output; host agent only logs at
 *                                    trace; full result available at execution_complete
 *   assistant.streaming_delta      — raw byte-count progress; not user-visible
 *   assistant.turn_start/end       — internal lifecycle markers
 *   assistant.intent               — internal planning; not surfaced
 *   model.call_failure             — emitted before session.error; session.error
 *                                    carries the same info more clearly
 *   session.start / resume         — internal lifecycle
 *   pending_messages.modified      — queue state, internal
 *   session.mcp_*                  — MCP server lifecycle, not user-visible
 *   session.skills_loaded          — initialisation marker
 *   session.shutdown (routine)     — normal exit, handled by abort/cancellation
 *   ~60 other events               — subagent bookkeeping, canvas, hooks, etc.
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
	contextTokens?: number;
	contextLimit?: number;
}

export interface RouterState {
	/** Id of the reasoning block currently being streamed, or null. */
	currentReasoningId: string | null;
	/** Reasoning IDs that have received delta events — used to skip the final
	 *  full-text `assistant.reasoning` event that fires after all deltas. */
	reasoningIdsWithDeltas: Set<string>;
	/** Active tool calls: toolCallId → toolName. */
	activeToolCalls: Map<string, string>;
	/** Cumulative token usage for this turn. */
	usage: TokenUsage;
	/** Model id reported by the runtime, if any. */
	modelId: string | null;
	/** Whether the turn reached idle. */
	completed: boolean;
	/**
	 * Whether the model has produced any output this turn.
	 *
	 * The runtime fires `session.idle` both after session-init / tool-list reload
	 * (before the model starts) AND after the model completes the turn.  We must
	 * ignore the first idle and only resolve on the second.  Once any model output
	 * event arrives (message delta, tool start, reasoning, …) this flag is set,
	 * and the next `session.idle` is the real turn-completion idle.
	 */
	hasOutput: boolean;
}

export function createInitialRouterState(): RouterState {
	return {
		currentReasoningId: null,
		reasoningIdsWithDeltas: new Set(),
		activeToolCalls: new Map(),
		usage: { inputTokens: 0, outputTokens: 0 },
		modelId: null,
		completed: false,
		hasOutput: false,
	};
}

// ─── Router ───────────────────────────────────────────────────────────────────

/**
 * Route a single SDK session event to the chat stream, mutating and returning
 * the router state.  `onIdle` is invoked exactly once when the turn completes.
 */
export function routeSessionEvent(
	event: SessionEvent,
	stream: vscode.ChatResponseStream,
	state: RouterState,
	onIdle: () => void,
): RouterState {
	switch (event.type) {

		// ── Reasoning / thinking ──────────────────────────────────────────────

		case 'assistant.reasoning_delta': {
			const id = event.data.reasoningId;
			if (!state.reasoningIdsWithDeltas.has(id)) {
				state.reasoningIdsWithDeltas.add(id);
				stream.thinkingProgress?.({ id, text: 'Thinking…\n' });
			}
			state.currentReasoningId = id;
			state.hasOutput = true;
			if (event.data.deltaContent) {
				stream.thinkingProgress?.({ id, text: event.data.deltaContent });
			}
			return state;
		}
		case 'assistant.reasoning': {
			// Final stored event that fires after all deltas.  Only use it as a
			// non-streaming fallback (no deltas received).
			if (!state.reasoningIdsWithDeltas.has(event.data.reasoningId) && event.data.content) {
				stream.thinkingProgress?.({ id: event.data.reasoningId, text: event.data.content });
			}
			state.hasOutput = true;
			state.currentReasoningId = null;
			return state;
		}

		// ── Assistant response text ───────────────────────────────────────────

		case 'assistant.message_delta': {
			if (event.data.deltaContent) {
				state.hasOutput = true;
				stream.markdown(event.data.deltaContent);
			}
			return state;
		}
		case 'assistant.message': {
			// Final stored event — captures model id and output token count.
			state.hasOutput = true;
			if (event.data.model) { state.modelId = event.data.model; }
			if (typeof event.data.outputTokens === 'number') {
				state.usage.outputTokens = event.data.outputTokens;
			}
			return state;
		}

		// ── Tool lifecycle ────────────────────────────────────────────────────

		case 'tool.execution_start': {
			state.activeToolCalls.set(event.data.toolCallId, event.data.toolName);
			state.hasOutput = true;
			log('tool.execution_start', { toolCallId: event.data.toolCallId.slice(0, 13), toolName: event.data.toolName });
			stream.progress(`Running ${event.data.toolName}…`);
			return state;
		}
		case 'tool.execution_progress': {
			// Live progress message from long-running tools (e.g. bash commands).
			// Host agent only logs these at trace; we surface them as stream.progress
			// so the user can see activity without cluttering the response text.
			if (event.data.progressMessage) {
				stream.progress(event.data.progressMessage);
			}
			return state;
		}
		case 'tool.execution_partial_result': {
			// Streaming partial output (e.g. incremental bash stdout).  The host
			// agent only logs these at trace; full output is available at
			// execution_complete.  We skip them to avoid redundant noise.
			return state;
		}
		case 'tool.execution_complete': {
			const toolName = state.activeToolCalls.get(event.data.toolCallId) ?? 'tool';
			state.activeToolCalls.delete(event.data.toolCallId);
			if (!event.data.success && event.data.error) {
				const msg = (event.data.error as { message?: string }).message ?? String(event.data.error);
				log('tool.execution_complete (failed)', { toolCallId: event.data.toolCallId.slice(0, 13), toolName, error: msg });
			} else {
				log('tool.execution_complete', { toolCallId: event.data.toolCallId.slice(0, 13), toolName });
			}
			return state;
		}

		// ── Skills and subagents ──────────────────────────────────────────────

		case 'skill.invoked': {
			log('skill.invoked', { name: event.data.name });
			state.hasOutput = true;
			stream.markdown(`\n\n> 🧩 Skill: \`${event.data.name}\`\n`);
			return state;
		}
		case 'subagent.started': {
			log('subagent.started', { agentName: event.data.agentName });
			state.hasOutput = true;
			stream.progress(`Delegating to ${event.data.agentDisplayName}…`);
			return state;
		}

		// ── Token usage ───────────────────────────────────────────────────────

		case 'assistant.usage': {
			if (typeof event.data.inputTokens === 'number') {
				state.usage.inputTokens = event.data.inputTokens;
			}
			if (typeof event.data.outputTokens === 'number') {
				state.usage.outputTokens = event.data.outputTokens;
			}
			if (event.data.model) { state.modelId = event.data.model; }
			return state;
		}
		case 'session.usage_info': {
			state.usage.contextTokens = event.data.currentTokens;
			state.usage.contextLimit = event.data.tokenLimit;
			return state;
		}

		// ── Session lifecycle ─────────────────────────────────────────────────

		case 'session.error': {
			// Runtime error (auth failure, quota, context limit, model not found, …).
			// Surface the message and mark hasOutput so the next session.idle resolves.
			const { errorType, message, errorCode } = event.data;
			log('session.error', { errorType, errorCode, message: message.slice(0, 200) });
			state.hasOutput = true;
			stream.markdown(`\n\n> ⚠️ Copilot error (${errorType}${errorCode ? ` · ${errorCode}` : ''}): ${message}\n`);
			return state;
		}
		case 'session.warning': {
			// The 'mcp' warningType fires on MCP tool auth/permission failures.
			// Other categories: 'subscription', 'policy'.  Surface them all.
			const { warningType, message: warnMsg, url } = event.data;
			log('session.warning', { warningType, message: warnMsg.slice(0, 200) });
			state.hasOutput = true;
			const urlSuffix = url ? ` [Learn more](${url})` : '';
			stream.markdown(`\n\n> ⚠️ Warning (${warningType}): ${warnMsg}${urlSuffix}\n`);
			return state;
		}
		case 'session.mcp_servers_loaded': {
			// Fires once after all MCP servers finish their startup sequence.
			// Log per-server status so failed servers are visible in the dev console.
			const servers = event.data.servers;
			for (const s of servers) {
				if (s.status === 'failed' || s.error) {
					log(`session.mcp_servers_loaded — ${s.name} FAILED`, { status: s.status, error: s.error });
					stream.progress(`MCP server "${s.name}" failed to connect: ${s.error ?? s.status}`);
				} else {
					log(`session.mcp_servers_loaded — ${s.name}`, { status: s.status });
				}
			}
			return state;
		}
		case 'session.mcp_server_status_changed': {
			const { serverName, status, error } = event.data;
			log('session.mcp_server_status_changed', { serverName, status, error });
			if (status === 'failed' && error) {
				stream.progress(`MCP server "${serverName}" failed: ${error}`);
			}
			return state;
		}
		case 'session.idle': {
			if (!state.hasOutput) {
				// Initialization idle — fires after tool-list registration / config
				// discovery, before the model starts responding.  Ignore it.
				log('session.idle (initialization — ignored)');
				return state;
			}
			state.completed = true;
			log('session.idle', { inputTokens: state.usage.inputTokens, outputTokens: state.usage.outputTokens, modelId: state.modelId });
			onIdle();
			return state;
		}
		case 'session.shutdown': {
			if (event.data.shutdownType === 'error') {
				const reason = event.data.errorReason ?? 'runtime crashed';
				log('session.shutdown (error)', { reason });
				stream.markdown(`\n\n> ⚠️ Copilot CLI session terminated: ${reason}\n`);
				if (!state.completed) {
					state.completed = true;
					onIdle();
				}
			}
			// routine shutdown is handled by session.abort() + cancellation token
			return state;
		}

		default:
			return state;
	}
}
