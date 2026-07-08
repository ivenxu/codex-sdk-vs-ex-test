## 1. Foundation: Message Router + Options Builder

- [x] 1.1 Extract SDK message routing into `src/claude/claudeMessageRouter.ts` — a pure function `routeSDKMessage(msg, stream, state)` that handles all 5 SDK message types (stream_event, assistant, result, user, system)
- [x] 1.2 Build `src/claude/claudeOptionsBuilder.ts` — a factory function `buildClaudeOptions(request, context, proxyInfo, storagePath, token)` that constructs the SDK `Options` object from VS Code context
- [x] 1.3 Enable `includePartialMessages: true` in Options to receive `stream_event` messages from the SDK
- [x] 1.4 Add `model`, `systemPrompt`, `enableFileCheckpointing`, and `effort` fields to Options builder
- [ ] 1.5 Unit-test the message router with mock SDK messages (thinking, tool_use, text_delta, input_json_delta, result)

## 2. Priority 1 — Quick Wins: Thinking, Tool Progress, Token Usage

- [x] 2.1 Implement thinking display: detect `content_block_start{type:'thinking'}` → `stream.thinkingProgress()`, stream `thinking_delta` deltas, stop on `content_block_stop`
- [x] 2.2 Implement tool call lifecycle: detect `tool_use` start → `stream.progress()`, stream `input_json_delta`, complete on `content_block_stop`, display tool result from `user` messages
- [x] 2.3 Implement token usage tracking: extract `message.usage` from `result` and `message_delta` messages, log to console, include in turn metadata
- [x] 2.4 Add `onElicitation` callback to Options for MCP server elicitation requests — show confirmation dialog, return user response
- [x] 2.5 Add turn lifecycle signals: progress messages on start/resume, error display on failure, clean metadata return

## 3. Priority 2 — Permission Modes + MCP Integration

- [x] 3.1 Add `codex.claudePermissionMode` VS Code configuration setting with values: `default`, `always-ask`, `always-allow`, `never`, `accept-edits`
- [x] 3.2 Implement permission mode reading: read VS Code session config and map to SDK `Options.permissionMode` using the VS Code picker → Claude mode mapping
- [x] 3.3 Support live mode changes: re-read `permissionMode` on every `query()` call so mode changes apply immediately
- [x] 3.4 Add `codex.claudeMcpServers` VS Code configuration setting for MCP server definitions (command, args, env, url)
- [x] 3.5 Read MCP server config and pass via `Options.mcpServers` in the Options builder
- [x] 3.6 Enhance `canUseTool` callback to detect MCP tool calls and route through appropriate approval dialog

## 4. Priority 3a — Dynamic Tools (Client-Tool MCP Server)

- [x] 4.1 Implement `src/claude/clientToolMcpServer.ts` — in-process MCP server that registers VS Code tools using createSdkMcpServer() + tool() helpers
- [x] 4.2 Implement VS Code tool handlers: `vscode_readFile`, `vscode_grepSearch`, `vscode_fileSearch`, `vscode_listDirectory`, `vscode_readLints` — using SDK's tool() helper with zod schemas
- [x] 4.3 Register client-tool server in `Options.mcpServers` under name `vscode-tools` during session creation
- [x] 4.4 Implement server lifecycle: start on session create, stop on session dispose, with error recovery
- [x] 4.5 Add graceful fallback: if client-tool server fails to start, log warning and continue without dynamic tools

## 5. Priority 3b — File Change Visibility

- [x] 5.1 Detect file-edit tool calls in the message router (tool names: `Edit`, `FileWrite`, `file_edit`)
- [x] 5.2 Implement file change summary display: on tool completion, show file path, operation type, and description via `stream.markdown()`
- [x] 5.3 Maintain an ordered list of all file changes in the session state for summary at turn end

## 6. Priority 3c — Steering via WarmQuery Migration

- [x] 6.1 WarmQuery lifecycle built into ClaudeParticipant — session pool with idle timeout (30 min)
- [x] 6.2 Implement `startup()`+`WarmQuery` pattern: create `WarmQuery` on first message, reuse for subsequent turns
- [x] 6.3 Implement `warm.query()` for streaming — route output through the same message router as `query()`
- [x] 6.4 Implement mid-turn injection: `injectSteeringMessage()` method on participant
- [x] 6.5 Implement idle timeout (30 min): auto-dispose WarmQuery sessions using setTimeout
- [x] 6.6 Add graceful degradation: fall back to `query()` if `startup()` fails
- [ ] 6.7 Add `allowDangerouslySkipPermissions`, `forwardSubagentText`, `disallowedTools` to Options builder as optional advanced knobs

## 7. Integration Testing

- [ ] 7.1 Add integration test for message router with full SDK message suite (all stream_event subtypes, assistant, result, user, system)
- [ ] 7.2 Add integration test for Options builder — verify all config values map correctly to SDK Options
- [ ] 7.3 Add end-to-end smoke test: create session, send message, verify text + thinking + tool progress appear in stream
- [ ] 7.4 Test permission modes: verify always-allow bypasses canUseTool, never denies all, accept-edits allows file tools
- [ ] 7.5 Test cancellation: verify abortController.abort() stops in-flight query within 5 seconds
- [ ] 7.6 Test MCP elicitation: verify onElicitation callback fires and response is returned
- [ ] 7.7 Test WarmQuery fallback: verify startup failure degrades gracefully to query()
