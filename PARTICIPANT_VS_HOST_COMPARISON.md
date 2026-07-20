# Participant vs VS Code Host Agent — Comprehensive Comparison

**Generated**: 2026-07-15  
**Sources**: `src/codexParticipant.ts`, `src/copilotParticipant.ts`, `src/claudeParticipant.ts`,
`VSCODE_CODEX_ARCHITECTURE_DEEP_DIVE.md`, `VSCODE_COPILOT_CLI_ARCHITECTURE_DEEP_DIVE.md`,
`VSCODE_CLAUDE_ARCHITECTURE_DEEP_DIVE.md`, `GAP_ANALYSIS.md`,
`node_modules/@github/copilot-sdk/dist/generated/rpc.d.ts`

---

## 1. Architecture Overview

The fundamental difference: host agents run **inside the VS Code process** and communicate via
direct IPC + rich internal APIs. Our participants run in an **extension host process** and
communicate only through the public `vscode.chat` extension API — specifically `handleRequest()`.

```
VS Code Host Agent                        Our Participants (Extension Host)
─────────────────────                     ──────────────────────────────────
VS Code Core                              VS Code Core
  ↓ Internal IPC                            ↓ Public Extension API only
agentHostMain.ts                          extension.ts
  ├── CodexAgent.ts           ←→           CodexParticipant.ts
  ├── ClaudeAgent.ts          ←→           ClaudeParticipant.ts
  └── CopilotAgent.ts         ←→           CopilotParticipant.ts

Entry points available:                   Entry points available:
  sendMessage(uri, prompt, turnId)          handleRequest(request, context, stream, token)
  abortSession(uri)                         [ONLY ONE ENTRYPOINT]
  createSession(config)
  truncateSession(uri, turnId)
  restoreSnapshot(snapshotRequestId)
  respondToPermissionRequest(id, approved)
  changeModel(uri, modelId)
  changeAgent(uri, agentId)
  setCheckpoint(uri, data)
  ...25+ methods
```

---

## 2. Session Lifecycle

### 2.1 VS Code Host Agents

| Step | Codex Host | Claude Host | Copilot Host |
|------|-----------|-------------|--------------|
| **Create** | `CodexAgent.createSession()` stores provisional; subprocess starts. No SDK call yet. | `ClaudeAgent.createSession()` stores provisional; nonce proxy started. No SDK call yet. | `CopilotAgent.createSession()` stores provisional; CLI subprocess spawned eagerly. SDK session deferred. |
| **Materialize** | Lazy — `thread/start` RPC on first `sendMessage()`. Thread restartable if tools change. | Lazy — `startup()` / `query()` on first `sendMessage()`. | Lazy — `client.session.create()` on first `sendMessage()`. |
| **Resume** | `thread/resume` RPC with saved `threadId`. Retried from disk metadata if not in memory. | `query({ resume: sessionId })` or `startup({ resume })`. Session history from `~/.claude/`. | `client.resumeSession(savedSessionId)` with MCP fields intentionally omitted. |
| **Persist** | `codexSessionMetadataStore` writes `{threadId, cwd, modelId}` to disk per session. Survives VS Code restart. | `ClaudeSessionMetadataStore` on disk (session ID, model). History in `~/.claude/`. | SDK (`@github/copilot`) stores session state on disk internally. Minimal host metadata in memory. |
| **Idle timeout** | None (subprocess stays alive) | 30-min idle timer via `WARMQUERY_IDLE_TIMEOUT_MS` in our impl; host has no timer | None |
| **Dispose** | `agent.disposeSession()` → `thread/cancel` → subprocess cleanup | `warmQuery[Symbol.asyncDispose]()` | `client.stop()` → kills CLI subprocess |
| **Token rotation** | Nonce proxy restart; sessions survive | Proxy restart; sessions survive | `_ensureClient()` restarts CopilotClient only when all sessions are idle |
| **Error recovery** | `_onConnectionExit` rejects all pending, forces new connection | Graceful fallback to `query()` if WarmQuery fails | `session.shutdown error` evicts the session; next message creates fresh session |

### 2.2 Our Participants

| Step | Codex Participant | Claude Participant | Copilot Participant |
|------|------------------|-------------------|---------------------|
| **Create** | `conn.startThread()` on first `handleRequest()`. No provisional. | `query()` on first `handleRequest()`. No provisional. | `client.createSession()` on first `handleRequest()`. |
| **Materialize** | Immediate — no lazy deferral | Immediate | `_getOrCreateSession()` creates/resumes synchronously |
| **Resume** | `conn.resumeThread({ threadId })` if `threadId` in `context.history` | `query({ resume: savedSessionId })` if found in history | `client.resumeSession(savedSessionId)` if in history |
| **Persist** | Thread ID in `result.metadata` (in-memory only via VS Code Chat history) | Session ID in `result.metadata` | Session ID in `result.metadata` |
| **Idle timeout** | None | 30-min `WARMQUERY_IDLE_TIMEOUT_MS` | None |
| **Dispose** | `dispose()` kills connections | `dispose()` disposes WarmQuery sessions | `dispose()` calls `client.stop()` |
| **Token rotation** | Not handled; proxy restart requires extension reload | Not handled | `_ensureClient()`: restarts when token changes and sessions=0 |
| **Error recovery** | `_onConnectionExit()` rejects pending, flags sessions | WarmQuery falls back to `query()` | `session.shutdown error` evicts session |

### Key Gap: Checkpoint-aware Session Lifecycle
Host agents expose `createSession`, `abortSession`, `truncateSession`, `setCheckpoint` as **separate
named methods** called from outside. Our participants only have `handleRequest()`. The lifecycle
signals (checkpoint restore, abort, session config change) cannot reach the participant unless encoded
as special request messages.

---

## 3. Turn Lifecycle

### 3.1 VS Code Host — Turn Flow

**Common pattern across all three agents:**

```
workbench → agentSideEffects.handleAction(ChatTurnStarted)
         → agent.sendMessage(sessionUri, prompt, attachments, turnId)
         → [materialization if provisional]
         → underlying send (thread/start or session.send or query())
         → stream events back via actions (ChatMarkdownChunk, ChatToolCallStart, etc.)
         → session.idle / turn/completed → ChatTurnComplete
         → workbench releases turn lock
```

| Dimension | Codex Host | Claude Host | Copilot Host |
|-----------|-----------|-------------|--------------|
| **Turn ID** | `turnId` passed from workbench → stored as `session.codexTurnIdByHostTurnId[turnId]` on `turn/completed` | `turnId` passed but used for history only | `turnId` passed via `send()`, stored as `_turnId` |
| **Turn sequencing** | `_sessionSequencer.queue(sessionId, ...)` — serializes turns | N/A (query is inherently serial per session) | `_queueTurn(entry, fn)` — sequencer per session |
| **Turn completion** | `turn/completed` RPC notification → `ChatTurnComplete` action | `message_stop` SSE or `WarmQuery` finish | `session.idle` SDK event → `resolveIdle()` |
| **Cancellation** | `abortSession(uri)` → `turn/interrupt { threadId, turnId }` → await `turn/completed(interrupted)` | `ac.abort()` on AbortController | `session.abort()` on CancellationToken |
| **Pre-cancel cleanup** | `_drainPendingSteering(session)` clears buffered steering | N/A | `permission.dispose()` |

### 3.2 Our Participants — Turn Flow

| Dimension | Codex Participant | Claude Participant | Copilot Participant |
|-----------|------------------|-------------------|---------------------|
| **Turn ID** | `startResult.id` stored as `session.currentAppTurnId`; NOT mapped to host `turnId` | Not tracked | `entry.current` set; no host-turn→SDK-event mapping |
| **Turn sequencing** | Awaits `session.turnDone` promise | Implicit — serial async iteration | `_queueTurn` sequencer per session |
| **Turn completion** | `turn/completed` notification → `turnResolve()` | Async iterator exhausted | `session.idle` → `resolveIdle()` |
| **Cancellation** | `token.onCancellationRequested` → `_interruptTurn()` → `turn/interrupt` ✅ | `ac.abort()` ✅ | `token.onCancellationRequested` → `session.abort()` ✅ |
| **Pre-cancel cleanup** | `pendingCommandApprovals.denyAll('cancel')` | None | `permission.dispose()` ✅ |
| **Safety timeout** | `INTERRUPT_TIMEOUT_MS = 5000` ✅ | None | `TURN_TIMEOUT_MS = 120000` ✅ |

---

## 4. History Management

### 4.1 Compact (context compression)

| | Codex Host | Claude Host | Copilot Host | Codex Participant | Claude Participant | Copilot Participant |
|---|---|---|---|---|---|---|
| **Method** | `/compact` slash → `rpc.history.compact()` | `--auto-compact` flag on CLI subprocess | `/compact` slash → `session.rpc.history.compact()` | `/compact` slash → `conn.compactHistory()` ❌ not implemented | N/A — Claude binary manages internally | `/compact` slash → `session.rpc.history.compact()` ✅ |
| **Trigger** | User slash command | Automatic (binary) or slash | User slash command | Not hooked | N/A | User `/compact` ✅ |

### 4.2 Truncate / Rollback (checkpoint restore)

This is the most significant lifecycle gap.

**Host agent flow** (Codex, verified from `codexAgent.ts:2058–2094`):
```typescript
// VS Code host calls:
agent.truncateSession(sessionUri, hostTurnId)
  → reads thread via thread/read
  → counts turns after target
  → conn.request('thread/rollback', { threadId, numTurns })

// VS Code host also:
vscode.restoreSnapshot(snapshotRequestId)  // restores files to checkpoint
```

**Copilot host flow** (from `copilotAgent.ts`, confirmed by SDK types):
```typescript
// VS Code host calls:
agent.truncateSession(sessionUri, hostTurnId)
  → resolves hostTurnId → sdkEventId via _turnId mapping
  → session.rpc.history.truncate({ eventId: sdkEventId })
// Returns: HistoryTruncateResult { eventsRemoved: number }
```

| | Codex Host | Copilot Host | Codex Participant | Claude Participant | Copilot Participant |
|---|---|---|---|---|---|
| **Rollback/truncate API** | `thread/rollback { threadId, numTurns }` | `session.rpc.history.truncate({ eventId })` | ❌ Not implemented | ❌ Not applicable (binary manages) | ❌ Not implemented |
| **hostTurnId→sdkId mapping** | `codexTurnIdByHostTurnId` populated on `turn/completed` | `_turnId` field + event ID from `session.getEvents()` | ❌ Missing | N/A | ❌ Missing |
| **Trigger mechanism** | `truncateSession()` called by workbench | Same | No API into participant | No API | No API (handleRequest only) |
| **File restore** | `restoreSnapshot()` called by workbench (separate) | Same | No API | No API | No API |

---

## 5. Checkpoint Restore — Full Flow

### 5.1 Host Agent (ground truth)

```
User clicks "Restore Checkpoint" on turn N in chat panel
  ↓
workbench.restoreCheckpoint(sessionUri, turn N)
  ├── (a) vscode.restoreSnapshot(snapshotRequestId)    ← file system restore
  ├── (b) agent.truncateSession(sessionUri, turnId)    ← history rollback
  │         ↓ (Codex) thread/rollback { numTurns }
  │         ↓ (Copilot) session.rpc.history.truncate({ eventId })
  └── (c) optionally restore input text
  ↓
Next sendMessage uses truncated history — model doesn't see removed turns
```

### 5.2 Our Participants — Missing Pieces

**The problem**: `handleRequest()` is the only participant entry point. The workbench's
`restoreCheckpoint` / `truncateSession` / `restoreSnapshot` calls go to the **host agent** —
they never reach extension-based participants.

```
User clicks "Restore Checkpoint" on turn N
  ↓
VS Code restores files (restoreSnapshot)    ← works, no participant involvement
VS Code truncates chat UI history           ← works, handled by workbench
  ↓
PROBLEM: participant backend NOT notified
  ↓
Next handleRequest():
  context.history has N-1 turns            ← VS Code gave us truncated history
  BUT:
    Codex: thread still has turns 1..M     ← model sees deleted turns!
    Claude: session history in ~/.claude/  ← model sees deleted turns!
    Copilot: SDK session history full      ← model sees deleted turns!
```

### 5.3 Workaround Protocol (two-phase via handleRequest)

Since participants only have `handleRequest()`, a **special message protocol** is required:

```
Phase 1 — "prepare-restore" message:
  handleRequest({ type: "prepare-restore", hostTurnId, checkpointId })
    Participant: abort in-flight → return { ok: true }
    Host: calls restoreSnapshot (file restore)

Phase 2 — "finalize-restore" message:
  handleRequest({ type: "finalize-restore", hostTurnId, checkpointId })
    Participant:
      → lookup persisted hostTurnId→sdkEventId/appTurnId mapping
      → (Codex)  conn.request('thread/rollback', { numTurns })
      → (Copilot) session.rpc.history.truncate({ eventId })
      → (Claude) no direct API — must recreate session
      → return { ok: true, eventsRemoved }
```

**This protocol is not currently implemented in any participant.**

---

## 6. Model Routing & Authentication Proxy

| | Codex Host | Claude Host | Copilot Host | Codex Participant | Claude Participant | Copilot Participant |
|---|---|---|---|---|---|---|
| **Proxy type** | Nonce proxy → CAPI (OpenAI Responses format) | Nonce proxy → CAPI (Anthropic messages format) | None — direct GitHub token | Nonce proxy (OpenAI Responses) ✅ | Nonce proxy (Anthropic messages) ✅ | Nonce proxy (OpenAI Responses via BYOK) ✅ |
| **Auth token** | GitHub Copilot nonce (256-bit hex) | Same pattern | Direct `gitHubToken` | Same ✅ | Same ✅ | Same ✅ |
| **Per-session isolation** | Nonce `.sessionId` suffix | Same | SDK handles per-session | Same ✅ | Same ✅ | Session ID in bearer token ✅ |
| **BYOK config** | `resolveByokSessionConfig()` → `providers/models` in `SessionConfig` | N/A | `resolveByokSessionConfig()` | Not applicable | Not applicable | `_byokSessionConfig()` mirrors host ✅ |
| **Model picker** | `AgentHostLanguageModelProvider` registered per session type | Same | Same | `request.model.id` used | `request.model.id` used | `request.model.id` used ✅ |
| **Token rotation** | Proxy restart on token change | Same | `_ensureClient()` restarts when idle | ❌ Not handled (proxy restart requires extension reload) | ❌ Same | ✅ Handled when sessions=0 |

---

## 7. Tool Execution

### 7.1 Dynamic Tools (VS Code LM Tools)

| | Codex Host | Copilot Host | Codex Participant | Claude Participant | Copilot Participant |
|---|---|---|---|---|---|
| **Registration** | `_buildDynamicTools()` merges server tools + client tools per session | `_createClientSdkTools()` → declaration-only `Tool[]` | `DynamicToolManager.buildDynamicTools()` → `thread/start.dynamicTools` ✅ | N/A (Claude binary manages tools) | `buildVsCodeTools()` → declaration-only `Tool[]` ✅ |
| **Execution routing** | `item/tool/call` → `_handleDynamicToolCallRpc()` → `vscode.lm.invokeTool()` | `external_tool.requested` event → `invokeTool()` | `item/tool/call` → `_handleToolCall()` → `invokeTool()` ✅ | N/A | `external_tool.requested` → `_handleExternalTool()` → `invokeTool()` ✅ |
| **Server vs client tool split** | Separate registry (`_serverToolHost` vs `pendingClientToolCalls`) | N/A | Not split — all routed to invokeTool | N/A | Not split (all VS Code LM tools) |
| **Tool re-registration** | `_restartThreadWithCurrentTools()` if tools change before first turn | Tools updated on session resume | Tool hash check; warns but doesn't restart ⚠️ | N/A | Tools passed on createSession; not updated mid-session ⚠️ |
| **overridesBuiltInTool** | Not needed (no collision) | Set for colliding names | Not set ⚠️ | N/A | ✅ `overridesBuiltInTool: true` |

### 7.2 MCP Integration

| | Codex Host | Copilot Host | Codex Participant | Claude Participant | Copilot Participant |
|---|---|---|---|---|---|
| **Config** | `AgentHostMcpServersConfigKey` schema → `-c mcp_servers.*=...` on startup | `mcpServers` in `SessionConfig` | `codex.mcpServers` config → `-c` args ✅ | Via `CLAUDE_CODE_DISABLE_MCP` / SDK options | `copilotcli.mcpServers` config → `SessionConfig.mcpServers` ✅ |
| **Lifecycle** | `mcpServer/startupStatus/updated` inventory refresh | SDK manages internally | `mcpServer/startupStatus/updated` → `_refreshMcpInventory()` ✅ | SDK managed | `enableConfigDiscovery: true` + `enableMcpApps: true` ✅ |
| **Tool routing** | `mcp://` side-channel, `handleMcpRequest()` | SDK internal | `mcpServer/tool/call` → `conn.mcpToolCall()` ✅ | SDK internal | SDK internal ✅ |
| **Approval** | `item/tool/requestUserInput` → `mcp_tool_call_approval_` prefix check | `onPermissionRequest` callback | `_handleMcpApproval()` ✅ | SDK's `canUseTool` callback | `_permissionCallback()` ✅ |
| **Elicitation** | `mcpServer/elicitation/request` | SDK internal | `_handleMcpElicitation()` ✅ | SDK internal | SDK internal ✅ |

---

## 8. Permission & Approval Handling

| | Codex Host | Claude Host | Copilot Host | Codex Participant | Claude Participant | Copilot Participant |
|---|---|---|---|---|---|---|
| **Approval mechanism** | `ChatToolCallReady` → workbench card → `respondToPermissionRequest()` | `canUseTool()` callback → `PermissionPromptRequest` | `onPermissionRequest` callback → 5-tier auto-approve → `ChatToolCallReady` | `vscode.lm.invokeTool('vscode_get_confirmation')` ⚠️ | `canUseTool()` via SDK | `CopilotPermissionHandler` ✅ |
| **Auto-approve tiers** | `acceptedForSession` cache | SDK permission mode | 5 tiers: session-resource, attachment, SDK temp, non-confirm server tool, sandboxed shell | None — every action needs explicit confirm ❌ | `permissionMode` (bypass/default/plan) ✅ | Tier-based: `skipPermission`, attachment paths, SDK temp files ✅ |
| **acceptForSession cache** | `acceptedForSession: Set<string>` | N/A | `_approvedForSession` by tool+kind | ❌ Not implemented | N/A | `_approvedForSession` by request kind ✅ |
| **Command approval** | `item/commandExecution/requestApproval` | N/A | `onPermissionRequest { kind: 'shell' }` | `_approveCommand()` ✅ | N/A | Via `CopilotPermissionHandler` ✅ |
| **File change approval** | `item/fileChange/requestApproval` | N/A | `onPermissionRequest { kind: 'write' }` | `_approveFileChange()` ✅ | N/A | Via `CopilotPermissionHandler` ✅ |
| **Permissions escalation RPC** | `item/permissions/requestApproval` | N/A | N/A | Falls through to `accept` ❌ | N/A | N/A |
| **Plan mode exit approval** | `onExitPlanModeRequest` (monkey-patched) | N/A | `requestExitPlanMode` injected in RPC | N/A | N/A | `_exitPlanModeCallback()` ✅ |
| **Autopilot bypass** | `autoApprove='autopilot'` → SDK mode `autopilot` | `permissionMode='bypassPermissions'` | SDK mode `'autopilot'` → CLI never asks | N/A | `permissionMode='bypassPermissions'` ✅ | `/autopilot` slash → SDK mode `'autopilot'` ✅ |

---

## 9. Agent Mode Support

| | Codex Host | Claude Host | Copilot Host | Codex Participant | Claude Participant | Copilot Participant |
|---|---|---|---|---|---|---|
| **Modes** | None (no mode concept) | `permissionMode`: default / plan / bypass | `'plan'` / `'interactive'` / `'autopilot'` | None | `permissionMode` via options builder ✅ | `/plan` / `/autopilot` slash commands ✅ |
| **Mode config** | `SessionConfigKey.Mode` per session | `chat.agents.claude.permissionMode` setting | `SessionConfigKey.Mode` + `AutoApprove` | N/A | `request.model`-driven | Slash command parsed from prompt ✅ |
| **Mode translation** | N/A | `permissionMode` → SDK option | `(mode, autoApprove)` → `CopilotSdkMode` | N/A | Direct SDK option ✅ | `parseLeadingSlashCommand()` → `agentMode` ✅ |
| **Plan mode shim** | N/A | N/A | Monkey-patches `sendRequest` to inject `requestExitPlanMode: true` | N/A | N/A | `_exitPlanModeCallback` ✅ (public SDK) |

---

## 10. Streaming Event Mapping

| Dimension | Codex Host | Claude Host | Copilot Host | Codex Participant | Claude Participant | Copilot Participant |
|---|---|---|---|---|---|---|
| **Event source** | JSON-RPC notifications from app-server | Anthropic SSE via proxy | SDK events from CLI subprocess (JSON-RPC) | Same | Same | Same |
| **Mapping layer** | `codexMapAppServerEvents.ts` | `claudeSdkMessageRouter.ts` | `mapSessionEvents.ts` | `codexParticipant.ts` inline handlers | `claudeMessageRouter.ts` ✅ | `copilotSessionEventRouter.ts` ✅ |
| **Markdown streaming** | `item/agentMessage/delta` → `ChatMarkdownChunk` | `content_block_delta` → `ChatMarkdownChunk` | `assistant.message_delta` → `ChatMarkdownChunk` | `ts.on('item/agentMessage/delta')` → `stream.markdown()` ✅ | `routeSDKMessage()` ✅ | `routeSessionEvent()` ✅ |
| **Thinking/reasoning** | `item/reasoning/summaryTextDelta` → thinking bubble | `thinking` content block | `assistant.reasoning_delta` → thinking bubble | `stream.thinkingProgress()` ✅ | Via router ✅ | Via router ✅ |
| **Tool call UI** | `ChatToolCallStart` / `ChatToolCallDelta` / `ChatToolCallReady` / `ChatToolCallComplete` | `tool_use` content → VS Code tool call | `tool.execution_start` → `ChatToolCallStart` | Progress labels only ⚠️ | Via router | Via router ✅ |
| **Token usage** | `thread/tokenUsage/updated` | `usage` in final message | `assistant.usage` | Logged, not displayed | Stored in metadata | Stored in metadata ✅ |
| **Turn complete signal** | `turn/completed` notification | Iterator exhaustion / `message_stop` | `session.idle` event | `session.turnDone` promise ✅ | Async iterator ✅ | `resolveIdle()` ✅ |

---

## 11. Workspace / Sandbox

| | Codex Host | Claude Host | Copilot Host | Codex Participant | Claude Participant | Copilot Participant |
|---|---|---|---|---|---|---|
| **Working directory** | `createSession({ workingDirectory })` + persisted | `workingDirectory` in session config | `createSession({ workingDirectory })` | `workspaceFolders[0]` ✅ | `workspaceFolders[0]` ✅ | `workspaceCwd()` = `workspaceFolders[0]` ✅ |
| **Sandbox policy** | `sandboxPolicy` in `turn/start`: `workspaceWrite` / `dangerFullAccess` / `readOnly` | `permissionMode` | `'plan'`/`'interactive'`/`'autopilot'` controls approval level | `sandbox: 'workspace-write'` only ⚠️ | `permissionMode` ✅ | SDK-managed via mode ✅ |
| **runtimeWorkspaceRoots** | Passed in `turn/start` for `workspace-write` | N/A | N/A | ❌ Not passed | N/A | N/A |
| **Additional writable dirs** | Config-driven extra dirs | N/A | N/A | ❌ Not supported | N/A | N/A |
| **Multi-root workspace** | All roots resolved and passed | Workspace root only | Workspace root only | `workspaceFolders[0]` only ❌ | Same ❌ | Same ❌ |
| **Worktree isolation** | Not supported (explicit `throw`) | Not supported | Optional Git worktree per session | Not supported | Not supported | Not supported |
| **Network access toggle** | `networkAccess` config | N/A | N/A | Always false ❌ | N/A | N/A |

---

## 12. Session Metadata Persistence

| | Codex Host | Claude Host | Copilot Host | Codex Participant | Claude Participant | Copilot Participant |
|---|---|---|---|---|---|---|
| **Disk-backed store** | ✅ `codexSessionMetadataStore` writes `{threadId, cwd, modelId}` to disk | ✅ `ClaudeSessionMetadataStore` | ✅ SDK writes session state; host has session DB | ❌ In-memory only (`result.metadata` in VS Code Chat history) | ❌ In-memory only | ❌ In-memory only |
| **Cross-restart recovery** | ✅ `provideChatSessionContent()` restores history from disk | ✅ Same | ✅ Same | ❌ Lost on VS Code restart | ❌ Lost | ❌ Lost |
| **Session history read** | `thread/read` → maps to VS Code chat turns | `getSessionMessages()` | `client.getSessionMessages()` | Via `context.history` (VS Code manages) | Same | Same |
| **Metadata fields** | `{threadId, cwd, modelId}` on disk | `{sessionId, model}` on disk | `{sessionId}` in SDK store | `{threadId}` in `result.metadata` only | `{sessionId, tokenUsage}` | `{sessionId, tokenUsage, modelId}` |
| **hostTurnId mapping** | `codexTurnIdByHostTurnId` (in-memory, lost on restart) | N/A | `_turnId` (in-memory) | ❌ Not tracked | N/A | ❌ Not tracked |

---

## 13. Mid-Turn Steering

| | Codex Host | Claude Host | Copilot Host | Codex Participant | Claude Participant | Copilot Participant |
|---|---|---|---|---|---|---|
| **API** | `turn/steer { threadId, input, expectedTurnId }` | N/A | N/A | ❌ Not implemented | ❌ N/A | ❌ N/A |
| **Buffer** | `pendingSteeringFlips` map | N/A | N/A | ❌ | N/A | N/A |
| **Echo detection** | Intercepts `item/started type=userMessage` | N/A | N/A | `userMessage` items ignored | N/A | N/A |
| **Turn promotion** | `_beginSteeringTurn()` on echo match | N/A | N/A | ❌ | N/A | N/A |
| **VS Code entrypoint** | `setPendingMessages(sessionUri, msg)` | N/A | N/A | ❌ No entrypoint | N/A | N/A |

---

## 14. Client / Runtime Lifecycle

| | Codex Host | Claude Host | Copilot Host | Codex Participant | Claude Participant | Copilot Participant |
|---|---|---|---|---|---|---|
| **Process model** | Separate `codex-rs` subprocess (stdio JSON-RPC) | In-process SDK (`@anthropic-ai/claude-agent-sdk`) | Separate CLI subprocess (`@github/copilot/index.js` via stdio JSON-RPC) | Same (subprocess via `AppServerConnection`) | Same (in-process `claude-agent-sdk`) | Same (CLI subprocess via `RuntimeConnection.forStdio()`) |
| **Startup timing** | Client: lazy (first request). Subprocess: eager on `createSession`. | Client: in-process, immediate | Client: lazy (`_ensureClient()`). Subprocess: eager on first `createSession`. | Connection on first `handleRequest()` | In-process, immediate | CopilotClient lazy on first `handleRequest()` |
| **Ripgrep on PATH** | Agent-host injects VS Code bundled `rg` | N/A | ✅ Agent-host resolves VS Code bundled `rg`, prepends to PATH | ❌ No rg injection | N/A | ❌ No rg injection (uses extension's node_modules rg) |
| **MXC sandbox bins** | ✅ `@microsoft/mxc-sdk` for shell sandboxing | N/A | ✅ Agent-host sets `MXC_BIN_DIR` | ❌ Not available | N/A | ❌ Not available (extension can't access `@microsoft/mxc-sdk`) |
| **SHELL_SPAWN_BACKEND** | N/A | N/A | ✅ Set on Linux for sandbox compat | N/A | N/A | ✅ Set on Linux ✅ |
| **RUBBER_DUCK_AGENT** | N/A | N/A | ✅ Optional rubber duck mode | N/A | N/A | ❌ Not set |

---

## 15. Gaps Summary Table

Each row is a capability. **"Possible in Participant"** means: can this gap be closed while
remaining in the extension-participant model (i.e., without moving into the host agent)?

| # | Capability Area | Codex Host | Claude Host | Copilot Host | Codex Participant | Claude Participant | Copilot Participant | **Possible in Participant?** |
|---|---|---|---|---|---|---|---|---|
| G1 | **Checkpoint restore — file restore signal** | ✅ `restoreSnapshot()` | ✅ | ✅ | ❌ | ❌ | ❌ | ⚠️ Partial — VS Code restores files automatically; participant is not notified but files are restored |
| G2 | **Checkpoint restore — history truncation** | ✅ `thread/rollback` | ✅ | ✅ `history.truncate` | ❌ | ❌ | ❌ | ✅ Yes — via two-phase `handleRequest` protocol (prepare/finalize messages) |
| G3 | **hostTurnId → sdkEventId / appTurnId mapping** | ✅ `codexTurnIdByHostTurnId` | N/A | ✅ `_turnId` + events | ❌ | N/A | ❌ | ✅ Yes — track at send-time, persist in `globalState` |
| G4 | **Disk-backed session metadata (cross-restart)** | ✅ `codexSessionMetadataStore` | ✅ | ✅ SDK-managed | ❌ | ❌ | ❌ | ✅ Yes — use `context.globalState` / `workspaceState` |
| G5 | **Mid-turn steering (`turn/steer`)** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ Codex only — needs `turn/steer` RPC + turn echo interception; complex, Phase 2 |
| G6 | **`acceptForSession` cache (command approval)** | ✅ | N/A | ✅ | ❌ | N/A | ✅ | ✅ Yes (Codex missing; Copilot already has it) |
| G7 | **`item/permissions/requestApproval` handling** | ✅ | N/A | N/A | ❌ falls through | N/A | N/A | ✅ Yes — add handler with proper network/filesystem response |
| G8 | **`sandboxPolicy` + `runtimeWorkspaceRoots` in turn** | ✅ | N/A | N/A | ❌ partial | N/A | N/A | ✅ Yes — pass in `startTurn()` params |
| G9 | **Multi-root workspace** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ Yes — iterate `workspaceFolders` |
| G10 | **Network access config toggle** | ✅ | N/A | N/A | ❌ | N/A | N/A | ✅ Yes — add `codex.networkAccess` setting |
| G11 | **Tool re-registration (restart thread on tool change)** | ✅ restarts | N/A | N/A | ❌ warns only | N/A | N/A | ✅ Yes — implement restart path in Codex participant |
| G12 | **Rich tool-call UI lifecycle** (`ChatToolCallStart`/`Delta`/`Ready`/`Complete`) | ✅ | ✅ | ✅ | ❌ progress labels only | ❌ | ✅ | ⚠️ Partial — `vscode.chat` API exposes `stream.button()`, `stream.progress()`, but not full `ChatToolCallReady` card without host-level API access |
| G13 | **Provisional session (lazy materialize)** | ✅ | ✅ | ✅ | ❌ immediate | ❌ immediate | ✅ | ✅ Yes — defer `thread/start` / SDK session create until first `handleRequest` message (Codex/Claude) |
| G14 | **Worktree isolation** | ❌ explicit throw | ❌ | ✅ optional Git worktree | ❌ | ❌ | ❌ | ❌ No — requires host-level Git worktree management; not available from extension API |
| G15 | **Ripgrep on subprocess PATH** | ✅ | N/A | ✅ | ❌ | N/A | ❌ | ✅ Yes — find VS Code bundled `rg` via `vscode.env` or `process.env.VSCODE_RG_PATH` and inject |
| G16 | **MXC sandbox binaries** | ✅ | N/A | ✅ | ❌ | N/A | ❌ | ❌ No — `@microsoft/mxc-sdk` is only in VS Code distribution, not available to extension node_modules |
| G17 | **Rubber duck mode (Copilot)** | N/A | N/A | ✅ | N/A | N/A | ❌ | ✅ Yes — set `RUBBER_DUCK_AGENT=true` env var on `CopilotClient` startup |
| G18 | **Token rotation handling** | ✅ | ✅ | ✅ idle-gated | ❌ | ❌ | ✅ | ✅ Yes (Codex/Claude missing; needs proxy restart coordination) |
| G19 | **Session-scope checkpoint event delivery** | ✅ `truncateSession()` RPC | ✅ | ✅ | ❌ no entrypoint | ❌ | ❌ | ⚠️ Protocol gap — requires two-phase `handleRequest` workaround (see §5.3) or a new proposed VS Code API |
| G20 | **History sync detection (fallback)** | N/A (uses explicit truncate) | N/A | N/A | ❌ | ❌ | ❌ | ✅ Yes — on each `handleRequest`, compare `context.history.length` vs SDK events; truncate if mismatch |
| G21 | **Plan mode monkey-patch shim** | N/A | N/A | ✅ internal | N/A | N/A | ❌ not applied | ✅ Yes — public `onExitPlanModeRequest` callback in SDK `SessionConfig`; shim not needed |
| G22 | **Session capability flags** (`supportsHandOffs`, `supportsFileAttachments`, etc.) | ✅ full set | ✅ full set | ✅ full set | ❌ no `contributes.chatSessions` capabilities block | ❌ | ❌ | ✅ Yes — add capabilities to `package.json` `contributes.chatParticipants` |

---

## 16. Priority-Ordered Action Items

Based on the gap table, ordered by impact and feasibility:

| Priority | Gap | Effort | Participant(s) |
|----------|-----|--------|----------------|
| 🔴 Critical | **G2** Checkpoint history truncation (two-phase `handleRequest` protocol) | Medium | Codex, Copilot |
| 🔴 Critical | **G3** hostTurnId → sdkEventId/appTurnId mapping | Small | Codex, Copilot |
| 🔴 Critical | **G20** History-sync fallback detection (compare history length on each turn) | Small | Codex, Copilot |
| 🟡 High | **G4** Disk-backed session metadata via `globalState` | Small | All |
| 🟡 High | **G6** `acceptForSession` approval cache | Small | Codex |
| 🟡 High | **G8** `sandboxPolicy` + `runtimeWorkspaceRoots` in `turn/start` | Small | Codex |
| 🟡 High | **G7** `item/permissions/requestApproval` full handler | Small | Codex |
| 🟢 Medium | **G15** Ripgrep binary injection into subprocess PATH | Small | Codex, Copilot |
| 🟢 Medium | **G11** Thread restart on tool change (Codex) | Medium | Codex |
| 🟢 Medium | **G13** Lazy materialize / provisional session (Codex, Claude) | Medium | Codex, Claude |
| 🟢 Medium | **G9** Multi-root workspace support | Small | All |
| 🟢 Medium | **G10** Network access config toggle | Small | Codex |
| 🟢 Medium | **G18** Token rotation handling (Codex, Claude) | Medium | Codex, Claude |
| 🔵 Low | **G17** Rubber duck mode env var | Tiny | Copilot |
| 🔵 Low | **G22** Session capabilities in package.json | Tiny | All |
| 🔵 Low | **G12** Richer tool-call UI lifecycle | Large | Codex |
| ⛔ Not possible | **G5** Mid-turn steering | — | Codex only, Phase 2 |
| ⛔ Not possible | **G14** Worktree isolation | — | Copilot only |
| ⛔ Not possible | **G16** MXC sandbox binaries | — | Copilot |
| ⛔ Protocol gap | **G19** Direct checkpoint event delivery | — | All — needs new VS Code proposed API or two-phase workaround |

---

## 17. The Core Constraint: `handleRequest()` as the Only Entry Point

The table below maps every host-agent method to its equivalent (or lack) in our participants:

| Host Agent Method | Purpose | Our Participant Equivalent |
|---|---|---|
| `createSession(config)` | Allocates provisional session | `handleRequest()` first call |
| `sendMessage(uri, prompt, turnId)` | Main turn | `handleRequest()` |
| `abortSession(uri)` | Cancel turn | `token.onCancellationRequested` inside `handleRequest()` |
| `truncateSession(uri, turnId)` | Checkpoint rollback | ❌ **No equivalent** — needs two-phase `handleRequest` protocol |
| `restoreSnapshot(id)` | File restore | ❌ **No equivalent** — workbench does this directly; participant not notified |
| `setCheckpoint(uri, data)` | Save checkpoint | ❌ **No equivalent** |
| `changeModel(uri, modelId)` | Change LM mid-session | ❌ **No equivalent** — participant reads `request.model` from each `handleRequest` |
| `changeAgent(uri, agentId)` | Change agent mode | ❌ **No equivalent** — participant reads slash command from prompt |
| `respondToPermissionRequest(id, approved)` | Tool approval response | ❌ **No equivalent** — handled via `vscode.lm.invokeTool('vscode_get_confirmation')` blocking call inside `handleRequest` |
| `getSessionSnapshot(uri)` | Read session state | ❌ **No equivalent** |
| `provideChatSessionContent(uri, token)` | History hydration | Uses `context.history` in `handleRequest` |

**Conclusion**: Any capability that requires out-of-band signalling (checkpoint events, model
changes, external abort, permission approvals from the UI) is structurally impossible through the
current `handleRequest()` API alone. Workarounds require either:
1. Encoding signals as special `handleRequest` messages (the two-phase protocol), or
2. A new VS Code proposed API (e.g., `vscode.chat.onCheckpointRestore`, `vscode.chat.onSessionAbort`)
   that the extension can subscribe to outside of `handleRequest()`.
