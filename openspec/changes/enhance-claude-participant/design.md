## Context

The `claude.participant` is a VS Code chat participant that uses `@anthropic-ai/claude-agent-sdk` to provide Claude Code capabilities inside VS Code Chat. It currently routes through a messages proxy (`src/proxy/messagesProxy.ts`) that translates Anthropic Messages API calls to VS Code's LM API.

The current implementation uses the SDK's `query()` function — a one-shot call that returns an `AsyncIterable<SDKMessage>`. It processes only `assistant` messages (extracting text) and `result` messages (capturing sessionId), ignoring the full `stream_event` message stream that carries thinking blocks, tool_use deltas, and lifecycle events.

The codex participant (`codexParticipant.ts`) at ~400+ lines demonstrates the full feature set: turn lifecycle, tool call streaming, approval dialogs, MCP integration, and dynamic tools. The VS Code agent-host Claude (`src/vs/platform/agentHost/node/claude/`) shows the canonical SDK usage pattern with `startup()`+`WarmQuery`, `buildOptions()`, `claudeSdkMessageRouter.ts`, and the client-tool MCP server pattern.

This design bridges the gap using a **hybrid approach**: retain the simpler `query()` API for Priority 1-2 features, and migrate to `startup()`+`WarmQuery` only for Priority 3 features that require it (steering, subagent support).

## Goals / Non-Goals

**Goals:**
- Full stream event processing (thinking, tool_use, input_json_delta, content_block_stop, message_delta)
- Tool call lifecycle display with progress and approval integration
- Configurable permission modes controlling auto-approval behavior
- MCP server configuration and tool call routing through SDK Options
- Client-tool MCP server for VS Code dynamic tools
- File change diff visibility in chat response
- Token usage tracking and turn lifecycle signals
- Mid-turn steering via WarmQuery migration
- Backward compatibility with existing chat sessions

**Non-Goals:**
- Replacing the messages proxy (no proxy changes needed)
- Adding MCP server inventory polling (SDK manages internally, low value for extension)
- Supporting subagent workflows (defers to later phase — complex plumbing)
- Changing codex participant (independent codebase)
- Adding UI beyond standard VS Code chat surfaces (no webviews)

## Decisions

### Decision 1: Hybrid SDK API — `query()` for P1/P2, `startup()`+`WarmQuery` for P3

**Choice**: Retain `query()` for Priority 1-2 features. Migrate to `startup()`+`WarmQuery` for steering and subagent support.

**Rationale**:
- `query()` is simpler, stateless, and sufficient for message streaming, tool display, and most SDK Options
- `startup()`+`WarmQuery` is needed only for steering and live mid-session configuration changes
- The agent-host uses `WarmQuery` because it manages long-lived sessions across VS Code restarts; the extension has per-conversation session lifetime which makes `query()` per-turn overhead negligible
- Migration can happen incrementally: add `includePartialMessages: true` to `query()` first (P1), then refactor to `WarmQuery` later (P3)

**Alternatives considered**:
- `startup()`+`WarmQuery` from day one: Premature complexity, more error-prone (pipeline rebind, session recovery)
- Keep `query()` forever: Blocks steering and live config changes

### Decision 2: Message routing via dedicated module

**Choice**: Extract message routing from `ClaudeParticipant.handleRequest()` into `claudeMessageRouter.ts` — a pure function that maps `SDKMessage` to VS Code chat stream actions.

**Rationale**:
- The agent-host's `claudeSdkMessageRouter.ts` proves this pattern is clean and testable
- Separates concern of "what does this SDK message mean" from "how does the participant work"
- Makes unit-testable without needing live SDK or VS Code API surfaces

**Pattern**:
```typescript
// claudeMessageRouter.ts
export function routeSDKMessage(
  msg: SDKMessage,
  stream: vscode.ChatResponseStream,
  state: RouterState
): RouterState {
  switch (msg.type) {
    case 'stream_event': return handleStreamEvent(msg, stream, state);
    case 'assistant': return handleAssistantMessage(msg, stream, state);
    case 'result': return handleResult(msg, stream, state);
    case 'user': return handleUserMessage(msg, stream, state);
    case 'system': return handleSystemMessage(msg, stream, state);
  }
}
```

### Decision 3: `includePartialMessages: true` as primary unlock

**Choice**: Set `includePartialMessages: true` in Options to receive `stream_event` messages from the SDK.

**Rationale**:
- Without this flag, the SDK only yields `assistant` (final combined) and `result` messages
- With it, the SDK yields real-time `stream_event` messages:
  - `content_block_start{type:'thinking'}` → thinking bubble
  - `content_block_delta{type:'thinking_delta'}` → thinking text streaming
  - `content_block_start{type:'tool_use'}` → tool call start
  - `content_block_delta{type:'input_json_delta'}` → tool input streaming
  - `content_block_stop` → tool call ready/complete
  - `message_delta` → stop_reason + usage
  - `message_stop` → turn complete
- The messages proxy already handles thinking blocks (via `LanguageModelThinkingPart`), so this is purely a participant-level change

**Risk**: More messages → more processing. Mitigation: router is O(1) per message, and stream_event messages are small deltas.

### Decision 4: Permission modes via session config (not SDK config)

**Choice**: Expose permission modes through standard VS Code chat session config (the "Set permission" picker), mapped to Claude's `ClaudePermissionMode`.

**Rationale**:
- The agent-host maps VS Code picker values (`default`/`autoApprove`/`autopilot`) to Claude's permission modes
- Follows identical pattern: `_readSessionPermissionMode()` → `Options.permissionMode`
- User sees familiar UI, not Claude-specific terminology

**Mapping**:
| VS Code Picker | SDK permissionMode |
|---|---|
| Default Approvals | `'default'` |
| Bypass Approvals | `'always-allow'` |
| Autopilot | `'always-allow'` |

### Decision 5: Dynamic tools via in-process MCP server

**Choice**: Build a client-tool MCP server in-process that registers VS Code tools (readFile, grepSearch, fileSearch, listDirectory, readLints) as Claude-accessible MCP tools.

**Rationale**:
- The agent-host uses the same pattern in `claudeClientToolMcpServer.ts`
- The SDK's `Options.mcpServers` accepts local MCP server configurations
- VS Code tools already exist in `codexParticipant.ts` — reuse the fallback tool implementations
- Avoids spawning a separate process; uses in-process stdio-based MCP transport

**Alternatives considered**:
- Pass tools through `canUseTool` only: Can't register new tools, only approve/deny existing ones
- Use `vscode.lm.invokeTool` directly: SDK doesn't support this path for tools it doesn't know about

## Risks / Trade-offs

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| SDK version incompatibility with `includePartialMessages` | Low | High — breaks streaming | Pin SDK version; add integration test |
| `startup()`+`WarmQuery` migration breaks existing sessions | Medium | Medium — lost conversation history | Keep `query()` as fallback; test migration path |
| Client-tool MCP server conflicts with Claude's built-in tools | Low | Medium — tool name collisions | Prefix VS Code tools with `vscode_` namespace |
| Permission mode mapping incomplete | Low | Low — always-ask fallback safe | Default to `'default'` mode unless explicitly configured |
| Memory growth from long-lived `WarmQuery` sessions | Medium | Medium — subprocess memory leak | Add session idle timeout (30min) with automatic cleanup |
| MCP server connection failures | Low | Medium — tools unavailable | Graceful fallback: log error, continue without dynamic tools |

## Open Questions

1. Should dynamic tools be namespaced under `vscode_` prefix to avoid collision with Claude's built-in tools?
   - **Proposal**: Yes — `vscode_readFile`, `vscode_grepSearch`, etc. Unambiguous and safe.
2. What is the idle timeout for `WarmQuery` sessions?
   - **Proposal**: 30 minutes of inactivity, then dispose and recreate on next use.
3. Should file change diff visibility include before/after preview or just a summary notification?
   - **Proposal**: Summary notification with file path and change count. Full diff is available in VS Code's built-in file editor diff view.
4. How should subagent support be exposed — through the SDK's built-in subagent functionality or custom MCP tools?
   - **Deferred**: This is Priority 3 and requires significant investigation. Decision can be made when implementation begins.
