# Codex POC → VS Code Agent-Host Gap Analysis

*Generated 2026-07-01 from research across vscode agent-host (`src/vs/platform/agentHost/node/codex/`) and codex-rs (`codex-rs/core/`, `codex-rs/app-server/`).*

---

## 1. Tool Use & Coordination

### What VS Code's agent-host does

| Layer | Mechanism |
|---|---|
| **Registration** | `_buildDynamicTools(session)` merges server tools (`_serverToolHost.definitions`) + client tools (`session.clientToolSet.merged()`), deduping by name. Passed as `dynamicTools` in `thread/start`. |
| **Server tools** | Executed in-process by the agent host. Dispatched directly in `_handleDynamicToolCallRpc`. |
| **Client tools** | Owned by workbench clients. Routed back to owning client via `ActiveClientToolSet.ownerOf(toolName)` + `session.pendingClientToolCalls`. |
| **Tool lifecycle** | `item/started` → `ChatToolCallStart` → `ChatToolCallDelta` → `ChatToolCallReady`. Results via `ChatToolCallContentChanged` → `ChatToolCallComplete`. |
| **Tool re-registration** | If tools change before first turn, agent-host restarts thread via `_restartThreadWithCurrentTools`. |
| **Approval** | `PendingRequestRegistry` parks deferred promises; `ChatToolCallReady` signals the workbench to show confirmation card. |

### What our POC does

| Layer | Status | Gap |
|---|---|---|
| **DynamicTools** | ✅ Implemented | `thread/start` now receives `dynamicTools` built from available VS Code LM tools. |
| **Function call routing** | ✅ Partial | `item/tool/call` is routed to `vscode.lm.invokeTool()` with a fallback dispatcher for common built-in tools. No separate server/client tool split is modeled yet. |
| **Tool lifecycle mapping** | ✅ Partial | The participant now surfaces item-level progress for `item/started`, `item/completed`, and output deltas. It does not yet emit the richer VS Code `ChatToolCallStart`/`Delta`/`Ready` sequence. |
| **Tool re-registration semantics** | ✅ Implemented | Tool set changes no longer restart the thread; the existing session continues and the user is warned that new tools are ignored. |
| **Client tool ownership** | ✅ N/A | The POC still has a single participant and does not implement a separate client-tool ownership model. |

### Root cause of `fileChange` absence

This is now largely addressed: once dynamic tools are registered on `thread/start`, Codex can surface file-editing capabilities through the tool bridge instead of falling back to `exec_command` for file operations. The remaining gap is not tool registration itself, but richer UI/tool lifecycle integration.

### Recommendation

1. **Fetch available LM tools** via the dynamic tool manager and pass them in `thread/start` — ✅ implemented
2. **Convert to `DynamicToolSpec[]`** with `name`, `description`, `inputSchema` — ✅ implemented
3. **Handle `item/tool/call`** by routing to `vscode.lm.invokeTool()` for VS Code tools — ✅ implemented
4. **Map results** to `DynamicToolCallResponse.contentItems` — ✅ implemented
5. **Add richer VS Code tool lifecycle events** (`ChatToolCallStart`/`Delta`/`Ready`/`Complete`) — still pending for fuller host-agent parity

---

## 2. MCP Use & Coordination

### What VS Code's agent-host does

| Layer | Mechanism |
|---|---|
| **Server discovery** | Codex owns MCP server lifecycle. Host polls via `mcpServerStatus/list` and refreshes inventory. |
| **Inventory exposure** | `_mcpInventory: Map<string, ICodexMcpServerEntry>`. Applied per-session via `McpCustomizationController.applyAll()`. |
| **Tool routing** | `mcp://` side-channel routes `tools/list`, `tools/call`, `resources/read` through `handleMcpRequest()`. |
| **Approval** | Codex surfaces MCP approvals as `item/tool/requestUserInput` with prefix `mcp_tool_call_approval_`. Host intercepts and renders on tool-approval card. Answers `Allow` / `__codex_mcp_decline__`. |
| **Lifecycle** | `mcpServer/startupStatus/updated` handler updates inventory on `ready`/`cancelled`. |
| **User config** | `AgentHostMcpServersConfigKey = 'mcpServers'` schema in `agentHostSchema.ts`. |
| **Startup suppression** | `features.tool_call_mcp_elicitation=false` passed to codex to use `requestUserInput` path instead of native MCP elicitation. |

### What our POC does

| Layer | Status | Gap |
|---|---|---|
| **MCP registration** | ❌ None | No `mcpServers` config, no inventory, no `dynamicTools` with MCP tool specs. |
| **MCP tool execution** | ❌ None | `item/tool/call` handler returns failure. No MCP tool routing. |
| **MCP approval** | ❌ None | No `requestUserInput` handling. |
| **MCP lifecycle** | ❌ None | No inventory refresh, no `startupStatus` handling. |

### Recommendation

1. **Expose MCP config** via `contributes.configuration` in `package.json` mirroring agent-host schema
2. **Pass `-c mcp_servers.xxx=...`** on codex startup so codex manages server processes
3. **Register notification handlers** for `mcpServer/startupStatus/updated`
4. **Handle `item/tool/requestUserInput`** for MCP tool approvals
5. **Route `item/tool/call`** to MCP execution when tool belongs to an MCP server

---

## 3. Workspace / Codespaces Passing & Mapping

### What VS Code's agent-host does

| Layer | Mechanism |
|---|---|
| **Working directory** | `createSession({ workingDirectory })`. Persisted in `codexSessionMetadataStore` (`codex.cwd`). |
| **Thread creation** | `thread/start` includes `cwd: session.workingDirectory.fsPath`. |
| **Sandbox policy** | `workspace-write` → `{ type: 'workspaceWrite', writableRoots: [cwd, ...additionalDirs] }`. `danger-full-access` → `dangerFullAccess`. `read-only` → `readOnly`. |
| **Runtime roots** | `turn/start` includes `runtimeWorkspaceRoots: writableRoots` for workspace-write. |
| **Remote/Codespaces** | No special handling in codex bridge. Working directory is resolved upstream. |
| **Session persistence** | `codexSessionMetadataStore` saves threadId, cwd, modelId per session. Restored on reconnect. |

### What our POC does

| Layer | Status | Gap |
|---|---|---|
| **cwd passing** | ✅ Partial | `thread/start` includes `cwd` from `workspaceFolders[0]`. |
| **Sandbox policy** | ✅ Partial | `sandbox: 'workspace-write'` passed. But no `sandboxPolicy` in turn options, no `runtimeWorkspaceRoots`. |
| **Session persistence** | ✅ Partial | Thread ID stored in `result.metadata` and recovered from history. But no disk-backed metadata store. |
| **Multi-root** | ❌ Missing | Only `workspaceFolders[0]` used. No multi-root support. |
| **Additional dirs** | ❌ Missing | No config for additional writable directories. |
| **Network access** | ❌ Missing | Always `networkAccess: false` (default sandbox). |

### Recommendation

1. **Pass `sandboxPolicy`** (not just `sandbox`) in `turn/start` for fine-grained control
2. **Include `runtimeWorkspaceRoots`** when using workspace-write
3. **Support multi-root** workspaces via config or automatic detection
4. **Add network access toggle** in extension settings
5. **Persist session metadata** to disk for cross-restart session continuity

---

## 4. Approval Process Mapping

### What VS Code's agent-host does

| RPC Method | Handler | Decision Values |
|---|---|---|
| `item/commandExecution/requestApproval` | `_handleCommandApprovalRequestRpc` | `accept`, `acceptForSession`, `decline`, `cancel` |
| `item/fileChange/requestApproval` | `_handleFileChangeApprovalRequestRpc` | `accept`, `acceptForSession`, `decline`, `cancel` |
| `item/permissions/requestApproval` | `_handlePermissionsApprovalRequestRpc` | `accept`, `acceptForSession` (maps to permissions + scope) |

**Flow**: codex RPC → resolve thread/item → `ChatToolCallReady` with `confirmationTitle` → workbench shows confirmation card → user approves/denies → resolve deferred → send decision to codex.

**Persistence**: `acceptedForSession: Set<string>` for per-command session acceptance. No disk persistence.

### What our POC does

| Layer | Status | Gap |
|---|---|---|
| **Command approval** | ✅ Partial | Shows `vscode_get_confirmation` prompt. Maps yes/no to `accept`/`cancel`. |
| **File change approval** | ✅ Partial | Same confirmation flow. |
| **Permission approval** | ❌ Missing | `item/permissions/requestApproval` falls through to generic `accept`. |
| **acceptForSession** | ❌ Missing | No per-session accepted cache. Every command requires re-approval. |
| **Confirmation UI** | ❌ Non-standard | Uses `vscode.lm.invokeTool('vscode_get_confirmation')` instead of agent-host's `ChatToolCallReady` pattern. Works but doesn't integrate with VS Code's native confirmation card. |

### Recommendation

1. **Add `acceptedForSession` set** to skip re-approval for accepted commands
2. **Handle `item/permissions/requestApproval`** with proper permission mapping
3. **Consider `ChatToolCallReady` pattern** for richer confirmation UI (requires session protocol integration — may be out of scope for POC)
4. **Minimum viable**: Add session-scoped acceptance cache + permissions handler

---

## 5. Permissions Mapping ("Set Permissions" pick → codex permissions)

### What VS Code's agent-host does

| Layer | Mechanism |
|---|---|
| **Config schema** | `permissions: { allow: string[], deny: string[] }` tool name lists. |
| **Auto-approval** | `sessionPermissions.ts` checks config before showing confirmation. |
| **Codex permissions RPC** | `item/permissions/requestApproval` maps to `PermissionsRequestApprovalParams` with `network` and `fileSystem` fields. Response includes `permissions` and `scope`. |
| **Sandbox vs Permissions** | Sandbox is base boundary. Permissions escalate beyond sandbox. Two separate concepts. |

### What our POC does

| Layer | Status | Gap |
|---|---|---|
| **Permissions config** | ❌ None | No tool permission allow/deny lists. |
| **Auto-approval** | ❌ None | Every action requires explicit confirmation. |
| **Permissions escalation** | ❌ None | `item/permissions/requestApproval` not handled. |

### Recommendation

1. **Add `codex.permissions` config** with `allow`/`deny` tool name arrays
2. **Check permissions before showing confirmation** (skip if tool in `allow` list, auto-deny if in `deny`)
3. **Handle permission escalation RPC** with proper network/filesystem response

---

## 6. Hooks Mapping

### What VS Code's agent-host does

| Layer | Mechanism |
|---|---|
| **Hook execution** | ❌ Host does **not** implement hooks. Codex app-server owns hook lifecycle. |
| **Protocol consumption** | Protocol exposes `hook/started`, `hook/completed`, `hooks/list`, `HookEventName`, `HookRunSummary`. Host does not consume them. |
| **Role** | Thin adapter — passes through codex app-server notifications without hook-specific logic. |

### What our POC does

| Layer | Status | Gap |
|---|---|---|
| **Hook support** | ❌ None | Same as agent-host — not required. Hooks are codex-internal. |

### Recommendation

**No action needed.** Hooks execute inside the codex app-server. The participant only needs to forward hook-related notifications if UI visibility is desired. For POC, skip.

---

## 7. Isolation Mapping (Workspace vs Worktree)

### What VS Code's agent-host does

| Layer | Mechanism |
|---|---|
| **Isolation model** | Workspace-scoped via `cwd` + `sandboxPolicy` + `runtimeWorkspaceRoots`. No worktree concept. |
| **Ephemeral threads** | Protocol supports `ephemeral: true`. Host does **not** use it. |
| **Forking** | Explicitly rejected: `throw new Error('Codex agent does not support session forking')`. |
| **Lazy materialize** | Thread deferred until first `sendMessage`. Restartable if tools change before first turn. |
| **Session persistence** | `codexSessionMetadataStore` saves threadId/cwd/modelId to disk. |

### What our POC does

| Layer | Status | Gap |
|---|---|---|
| **Isolation** | ✅ Basic | Uses `cwd` + `sandbox: 'workspace-write'`. |
| **Persistent sessions** | ✅ Basic | Thread ID in metadata enables cross-turn continuation. No disk persistence. |
| **Ephemeral sessions** | ❌ Missing | Always persistent. |
| **Lazy materialize** | ❌ Missing | Thread created immediately on first request. No restart capability. |

### Recommendation

1. **Disk-backed metadata store** for session continuity across VS Code restarts
2. **Lazy materialize**: defer `thread/start` until first `turn/start`; support restart if config changes
3. **Ephemeral threads**: for isolated experiments, pass `ephemeral: true`
4. **No worktree support needed** — workspace sandbox is adequate for POC

---

## 8. Turn Cancellation (User Cancels Mid-Request)

### What VS Code's agent-host does

| Layer | Mechanism |
|---|---|
| **Cancellation entry** | Workbench calls `abortSession(sessionUri)` → agent-host sends `turn/interrupt` RPC to codex. |
| **RPC format** | `{ method: "turn/interrupt", params: { threadId, turnId } }` (see `codexAgent.ts:2003`). |
| **Pre-cancellation cleanup** | `_drainPendingSteering(session)` clears buffered steering so pending bubbles don't outlive the turn. |
| **Post-cancellation** | Codex stops model inference, emits `turn/completed` with status `interrupted`. Agent-host maps to `ChatTurnComplete`. |
| **In-flight tool calls** | On session dispose, `pendingClientToolCalls.rejectAll(new CancellationError())` and `pendingCommandApprovals.denyAll('decline')`. |
| **Thread state** | After cancellation, thread remains loaded and can accept new `turn/start` calls. No cleanup needed. |

### What our POC does

| Layer | Status | Gap |
|---|---|---|
| **Cancellation handler** | ❌ Missing | `token.onCancellationRequested` rejects `turnDone` with `'Request cancelled'`, but never sends `turn/interrupt` to codex. Codex keeps running until model finishes. |
| **Graceful abort** | ❌ Missing | Codex subprocess continues processing; only the participant promise rejects. |
| **Resource cleanup** | ⚠️ Partial | `ts.removeAllListeners()` in `finally` block cleans up listeners. But unacknowledged approval requests could deadlock. |

### Recommendation

1. **On `token.onCancellationRequested`**: call `conn.client.request('turn/interrupt', { threadId, turnId })` **before** rejecting `turnDone`
2. **After interruption**: wait for `turn/completed` notification (may have `status: 'interrupted'`) before cleaning up
3. **Duration guard**: add a short timeout after `turn/interrupt` — if `turn/completed` doesn't arrive within 5s, force-cleanup anyway

### Protocol types needed

```typescript
interface TurnInterruptParams {
    threadId: string;
    turnId: string;
}
```

Note: `turnId` is the app-server turn id, not the host turn id. Our POC doesn't track this yet — the `TurnStartResponse.turn.id` value must be stored.

---

## 9. User Steering Messages (Mid-Turn Input)

### What VS Code's agent-host does

| Layer | Mechanism |
|---|---|
| **Steering RPC** | `turn/steer` — injects user input into a running turn. Params: `{ threadId, input, expectedTurnId }`. |
| **Buffering** | `session.pendingSteeringFlips: Map<string, PendingMessage>` buffers pending steering by message ID. |
| **Echo detection** | Codex echoes every `userMessage` item. Agent-host intercepts `item/started type=userMessage` and matches by text content against `pendingSteeringFlips`. |
| **Turn promotion** | When a steered message is echoed, `_beginSteeringTurn` completes the previous host turn and starts a new one. The codex app-server turn continues uninterrupted. |
| **Rejection handling** | If `turn/steer` fails (e.g., `expectedTurnId` mismatch because turn just completed), the buffered entry is cleared and the pending bubble is consumed. |
| **Workbench integration** | `setPendingMessages(sessionUri, steeringMessage)` is called by the workbench when user types mid-turn. |

### What our POC does

| Layer | Status | Gap |
|---|---|---|
| **Steering support** | ❌ None | No `turn/steer` RPC. No pending steering buffer. No `userMessage` echo interception. |
| **Mid-turn input** | ❌ None | User cannot send follow-up messages while codex is generating. |

### Recommendation

**Leave for Phase 2.** Steering requires:
- Tracking `currentAppTurnId` from `TurnStartResponse`
- Implementing `turn/steer` RPC
- Intercepting `item/started type=userMessage` notifications
- Managing `pendingSteeringFlips` buffer
- Emitting `ChatTurnComplete` / `ChatTurnStarted` for turn promotion

This is complex and not critical for POC. The cancel-and-resubmit pattern (Section 8) provides most of the user value.

---

## 10. Checkpoint Restore & History Sync

### What VS Code's agent-host does

| Layer | Mechanism |
|---|---|
| **Checkpoint UI flow** | User hovers a request → "Restore Checkpoint" → VS Code: (a) calls `restoreSnapshot(snapshotRequestId)` to undo file changes, (b) calls `truncateSession(sessionUri, turnId)` to roll back codex history, (c) optionally restores input text. |
| **`truncateSession` implementation** | `codexAgent.ts:2058-2094`: reads the persisted thread via `thread/read`, counts turns after the target `turnId`, then calls `thread/rollback { threadId, numTurns }`. |
| **Turn ID mapping** | `session.codexTurnIdByHostTurnId` maps VS Code turn IDs to codex turn IDs. Populated on each `turn/completed`. Used by `truncateSession` to resolve which turns to drop. |
| **Rollback RPC** | `thread/rollback { threadId, numTurns }` drops the last N turns from codex's in-memory context and persists a rollback marker in the rollout file. |
| **Post-rollback** | Agent-host does NOT immediately resume. On the next `sendMessage`, the normal lazy-materialize flow runs: `thread/resume` + `turn/start`. |

### What our POC does

| Layer | Status | Gap |
|---|---|---|
| **Rollback on checkpoint** | ❌ Missing | When user restores a checkpoint in VS Code, the chat UI truncates its history. But our POC **never calls `thread/rollback`** — codex's internal history retains the truncated turns. |
| **Resync on next turn** | ⚠️ Broken | The next `turn/start` after a checkpoint restore appends to codex's full (untruncated) history. The model sees turns that VS Code has removed from the UI. |
| **This causes** | 🔴 Bug | **Model hallucinates context from deleted turns.** Gets confused about past user requests that appear in codex history but not in VS Code UI. |
| **Turn ID tracking** | ❌ Missing | No `codexTurnIdByHostTurnId` mapping. Can't translate VS Code turn IDs to codex turn IDs. |
| **`thread/rollback` RPC** | ❌ Not implemented | Not in `AppServerConnection`. Protocol types exist in codex but not in our types.ts. |

### Why this is critical

You observed this exact issue: *"when a user restores to a checkpoint via vscode, the vscode get back to the checkpoint but doesn't sync this to codex history"*. This causes **desynchronization** between VS Code's displayed history and codex's model context. The model continues to "know" about turns the user has deleted from the UI.

### Recommendation (replaces Summary item #8)

| Action | Details |
|---|---|
| **1. Store `turnId` from every `TurnStartResponse`** | Maps to current app-server turn. On `turn/completed`, persist a `hostTurnId → codexTurnId` mapping. |
| **2. Expose `codexTurnId` in `result.metadata`** | Currently only `threadId` is in metadata. Also include the codex `turnId` so `truncateSession` can resolve the target. |
| **3. Implement `thread/rollback`** | Add to `AppServerConnection`: `rollbackThread(params: { threadId: string; numTurns: number })`. |
| **4. Call `thread/rollback` after checkpoint restore** | When VS Code calls `setCheckpoint()` and restores a snapshot, our POC must catch this and roll back codex's history. This requires VS Code API exposure for checkpoint events (may be a limitation). |
| **5. Alternative approach (no API access)** | Instead of listening for checkpoint events: on each new `turn/start`, compare VS Code's history length vs codex's history. If VS Code has fewer turns, call `thread/rollback` before the new turn. |

### Protocol types needed

```typescript
interface ThreadRollbackParams {
    threadId: string;
    numTurns: number;
}

interface ThreadReadParams {
    threadId: string;
    includeTurns?: boolean;
}
```

---

## Summary: Updated Priority Ordered Action Items

| # | Topic | Priority | Effort | Section |
|---|---|---|---|---|
| 1 | **Pass `dynamicTools` to codex** | 🔴 Critical | Medium | §1 |
| 2 | **Handle `item/tool/call`** (route tool execution) | 🔴 Critical | High | §1 |
| 3 | **Implement `turn/interrupt` on cancellation** | 🔴 Critical | Small | §8 |
| 4 | **Sync checkpoint restore → `thread/rollback`** | 🔴 Critical | Medium | §10 |
| 5 | **Add `acceptedForSession` cache** | 🟡 High | Small | §4 |
| 6 | **Handle `item/permissions/requestApproval`** | 🟡 High | Small | §4 |
| 7 | **Pass `sandboxPolicy` + `runtimeWorkspaceRoots` in turn options** | 🟡 High | Small | §3 |
| 8 | **Add tool permission config** (`allow`/`deny` lists) | 🟢 Medium | Medium | §5 |
| 9 | **MCP config + lifecycle** | 🟢 Medium | High | §2 |
| 10 | **Multi-root workspace support** | 🔵 Low | Small | §3 |
| 11 | **User steering messages** (`turn/steer`) | 🔵 Phase 2 | High | §9 |
| 12 | **Hooks notification forwarding** | 🔵 Low | Tiny | §6 |
| 13 | **Disk-backed session metadata store** | 🟢 Medium | Medium | §3
