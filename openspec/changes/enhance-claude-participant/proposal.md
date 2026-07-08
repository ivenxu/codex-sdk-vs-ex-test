## Why

The `claude.participant` chat participant currently implements only ~10% of the capabilities available in `codex.participant` — it streams basic text through the `@anthropic-ai/claude-agent-sdk` but lacks thinking/reasoning display, tool call progress, permission modes, MCP support, dynamic tools, and turn lifecycle management. The VS Code agent-host proves these features are all feasible via the SDK. Bridging this gap gives users a first-class Claude Code experience directly in VS Code Chat.

## What Changes

- **Stream event processing**: Enable `includePartialMessages` to process `stream_event` messages (thinking, tool_use, input_json_delta, content_block_stop) rather than only final `assistant` messages
- **Thinking/reasoning display**: Forward `content_block_start{type:'thinking'}` and `content_block_delta{type:'thinking_delta'}` to `stream.thinkingProgress()`
- **Tool call lifecycle**: Show progress for tool_use start (stream.progress), stream input JSON deltas, and mark completion on content_block_stop
- **Token usage tracking**: Extract and log token usage from `result` and `message_delta` messages
- **Model override**: Pass the user's chat model selection via `Options.model`
- **System prompt customization**: Support custom system prompts via `Options.systemPrompt`
- **MCP elicitation**: Handle MCP server user-input requests via `Options.onElicitation`
- **File checkpointing**: Enable `Options.enableFileCheckpointing` for safety
- **Permission modes**: Expose Claude's 6-level permission mode (`default`, `always-ask`, `always-allow`, `never`, `accept-edits`, `dontAsk`) via session config
- **MCP server support**: Pass MCP server configurations from VS Code settings via `Options.mcpServers`
- **MCP tool approval**: Detect MCP tool calls in `canUseTool` and route through approval dialog
- **Dynamic tool support**: Build a client-tool MCP server (in-process) to register VS Code tools as Claude tools, similar to the agent-host's approach
- **File change display**: Observe SDK file-editing activity and show diffs in the chat stream
- **Steering (mid-turn injection)**: Migrate to `startup()`+`WarmQuery` pattern to enable mid-turn message injection
- **Subagent support**: Wire subagent registry for Claude agent delegation

## Capabilities

### New Capabilities
- `thinking-display`: Real-time streaming of Claude's thinking/reasoning content to the VS Code chat thinking progress UI
- `tool-lifecycle`: Full tool call lifecycle — start/progress/completion — with input streaming and approval integration
- `permission-modes`: Configurable Claude permission modes controlling auto-approval behavior for tool calls
- `mcp-integration`: MCP server configuration, tool call routing, and elicitation handling through the SDK
- `dynamic-tools`: Host-provided VS Code tools surfaced to Claude via an in-process client-tool MCP server
- `turn-lifecycle`: Enhanced turn management with start/completion/interrupt signals and token usage tracking
- `file-change-visibility`: Display of Claude-initiated file edits and diffs in the chat response stream
- `steering`: Mid-turn message injection to guide active Claude sessions

### Modified Capabilities
- *(No existing specs to modify — this is a new implementation)*

## Impact

- **`src/claudeParticipant.ts`**: Major rewrite — expand from ~180 lines to ~500+ lines
- **`src/proxy/messagesProxy.ts`**: No changes needed (already handles all Anthropic↔VS Code translation)
- **`src/proxy/index.ts`**: No changes needed (existing proxy infrastructure suffices)
- **`package.json`**: No new dependencies (SDK already installed at `@anthropic-ai/claude-agent-sdk: ^0.3.193`)
- **VS Code settings**: Add `claude.permissionMode`, `claude.mcpServers` configuration keys
- **New files**:
  - `src/claude/claudeOptionsBuilder.ts` — Builds SDK `Options` object from VS Code context
  - `src/claude/claudeMessageRouter.ts` — Routes SDK messages to VS Code chat stream
  - `src/claude/claudeToolLifecycle.ts` — Tool call lifecycle management
  - `src/claude/clientToolMcpServer.ts` — In-process MCP server for VS Code dynamic tools
- **Performance**: SDK `startup()`+`WarmQuery` pattern maintains persistent subprocess (memory increase ~50-100MB for long sessions)
