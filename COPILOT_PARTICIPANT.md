# Copilot CLI Participant — Implementation Reference

## Overview

`CopilotParticipant` is a VS Code chat participant that bridges VS Code Chat to
the GitHub Copilot CLI via `@github/copilot-sdk`. It achieves feature parity
with `CodexParticipant` and `ClaudeParticipant` while exploiting the Copilot
SDK's **session-oriented, warm-by-design** process model.

Its headline differentiator over the built-in host-agent Copilot: an **optional
model proxy** that routes the runtime's model calls through VS Code's Language
Model API, unlocking any model the picker exposes (including third-party ones)
instead of being limited to CAPI.

---

## 1. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  One CopilotParticipant instance                             │
│                                                              │
│  _client:  CopilotClient | null                              │
│            └── ONE warm @github/copilot runtime subprocess   │
│                                                              │
│  _sessions: Map<sessionId, SessionEntry>                     │
│            └── { session, sequencer, current, unsubscribe }  │
│                one warm SDK session per conversation         │
│                                                              │
│  _lastToken / _lastProxyEnabled                              │
│            └── trigger a client restart when they change     │
└──────────────┬───────────────────────────────────────────────┘
               │
               │  (optional, when copilotcli.modelProxy.enabled)
               │  env: COPILOT_API_URL = http://127.0.0.1:N
               │       GITHUB_COPILOT_API_TOKEN = nonce
               │       COPILOT_CLI_DISABLE_WEBSOCKET_RESPONSES = true
               ▼
┌──────────────────────────────────────────────────────────────┐
│  Responses Proxy (src/proxy/responsesProxy.ts)              │
│  OpenAI Responses API ←→ VS Code LM API                     │
│  Selects model by request body id (selectChatModels({ id })) │
└──────────────┬───────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────┐
│  @github/copilot-sdk  →  @github/copilot runtime (stdio RPC) │
│  client.start()          spawns ONE subprocess               │
│  createSession({model})  warm, disk-backed session           │
│  session.send({...})     multi-turn, history preserved       │
│  session.on(handler)     ~80 typed SessionEvents             │
│  session.abort()         cancel the in-flight turn           │
└──────────────────────────────────────────────────────────────┘
```

**Auth**: the GitHub Copilot token is passed directly as
`CopilotClientOptions.gitHubToken` (no proxy for auth — unlike Claude/Codex,
which nonce-proxy their auth). When the model proxy is on, only the *model
endpoint* is redirected; auth to the proxy uses a localhost nonce.

---

## 2. Session Lifecycle

### Who owns sessions?

The **SDK/runtime** creates and persists sessions. `client.createSession()`
returns a live `CopilotSession`; the runtime writes history, planning state, and
artifacts **to disk** (we set `baseDirectory` to the extension's storage path to
isolate from `~/.copilot`). The participant keeps only the `sessionId` string —
persisted via `ChatResult.metadata` — to resume on the next turn.

### Session ID flow

```
TURN 1 (new session)
═══════════════════

handleRequest()
  ├─ findSessionIdInHistory() → undefined
  ├─ _ensureClient() → client.start()   (spawns subprocess once)
  ├─ createSession({ model: request.model.id, onPermissionRequest, onExitPlanModeRequest })
  │    SDK creates session "abc-123", entry stored in _sessions
  │    session.on(handler) → routeSessionEvent(...)
  ├─ send({ prompt, attachments, agentMode })
  │    events stream → stream.markdown / thinkingProgress / progress
  │    session.idle → resolveIdle()
  └─ return { metadata: { sessionId: "abc-123", tokenUsage, modelId } }

TURN 2 (resume / reuse)
═══════════════════════

handleRequest()
  ├─ findSessionIdInHistory() → "abc-123"
  ├─ _getOrCreateSession():
  │    _sessions.has("abc-123") ?  → reuse the warm in-memory entry
  │                              : → client.resumeSession("abc-123", ...)
  │                                   (reloads history from disk)
  └─ queued behind entry.sequencer → send({ prompt, ... })
```

### Comparison with Claude

| Responsibility | Claude | Copilot |
|---|---|---|
| **Create session** | first `query()` / `startup()` | `client.createSession()` |
| **Persist history** | SDK → `CLAUDE_CONFIG_DIR` | runtime → `baseDirectory` (disk) |
| **Resume session** | `options.resume = sessionId` | reuse `_sessions` entry, else `client.resumeSession(id)` |
| **Send prompt** | `query()` or `warmQuery.query()` | `session.send({ prompt })` |
| **Keep process alive** | `query()` cold each turn; `WarmQuery` keeps one alive | **always warm** — one subprocess, sessions reused |

---

## 3. Participant State

### `_client: CopilotClient | null`

One shared client = **one warm runtime subprocess** for the whole extension.
Created lazily in `_ensureClient()` and reused across all conversations. It is
only stopped on `dispose()` or restarted when the token rotates / the proxy
setting toggles **while no sessions are active** (env is fixed at spawn).

### `_sessions: Map<sessionId, SessionEntry>`

```typescript
interface SessionEntry {
    sessionId: string;
    session: CopilotSession;      // warm, multi-turn SDK session
    sequencer: Promise<void>;     // serializes turns on this session
    current: TurnContext | null;  // context of the in-flight turn, or null when idle
    unsubscribe: () => void;      // detach the event stream on dispose
}
```

The **event subscription and permission callback are bound once** at
create/resume time and read `entry.current` each time — so they always target
the *current* turn's stream/token, even across many turns on the same session.

```typescript
interface TurnContext {
    stream: vscode.ChatResponseStream;
    permission: CopilotPermissionHandler;
    routerState: RouterState;
    resolveIdle: () => void;
    toolInvocationToken: vscode.ChatRequest['toolInvocationToken'];
    token: vscode.CancellationToken;
}
```

### Turn serialization (the sequencer)

Turns on a single session are serialized so a second message waits for the first
to reach `session.idle`:

```typescript
private _queueTurn<T>(entry: SessionEntry, fn: () => Promise<T>): Promise<T> {
    const run = entry.sequencer.then(fn, fn);
    entry.sequencer = run.then(() => undefined, () => undefined);
    return run;
}
```

---

## 4. Warm by Design (no WarmQuery needed)

The Copilot SDK is **session-oriented from turn 1**, so it has no `query()` vs
`startup()`+`WarmQuery` split like Claude:

| | Claude | Copilot |
|---|---|---|
| Default call | `query()` — one-shot, subprocess per call | — |
| Warm construct | `startup()` → `WarmQuery` | **`session` itself** |
| Multi-turn send | `warmQuery.query(prompt)` | `session.send({ prompt })` |
| "Promotion" step | promote turn-1 → WarmQuery | **none** — warm from turn 1 |
| Idle eviction | 30-min timeout per warm process | not needed — one process serves all |
| Persistence | in-memory (lost on dispose/idle) | **disk-backed** — survives restart via resume |

⇒ Continuous chatting reuses **both** the subprocess and the session. Multiple
conversations multiplex onto the single subprocess, each with its own warm,
disk-backed session and its own picked model.

---

## 5. SDK Event Routing

`src/copilot/copilotSessionEventRouter.ts` is a **pure function** that converts
the runtime's ~80 typed `SessionEvent`s into VS Code stream API calls. Unknown
events are ignored (forward-compatible).

```
SDK SessionEvent                         → VS Code Stream API
──────────────────────────────────────────────────────────────────────
assistant.reasoning                      → stream.thinkingProgress(...)
assistant.reasoning_delta                → stream.thinkingProgress(...)
assistant.message                        → capture model / outputTokens
assistant.message_delta                  → stream.markdown(text)
tool.execution_start                     → stream.progress("Running X…")
tool.execution_complete                  → clear tool; surface errors
skill.invoked                            → stream.markdown("🧩 Skill: …")
subagent.started                         → stream.progress("Delegating…")
assistant.usage                          → accumulate RouterState.usage
session.usage_info                       → context token counts
session.idle                             → resolve the turn (onIdle)
```

`RouterState` accumulates `{ currentReasoningId, activeToolCalls, usage, modelId }`
and feeds the returned `TurnMetadata { sessionId, tokenUsage, modelId }`.

Unlike Claude, no `includePartialMessages` flag is needed — the Copilot SDK emits
structured streaming events natively once `streaming: true` is set on the session.

---

## 6. Permission Model

`src/copilot/copilotPermissionHandler.ts` — one handler per turn, wired to the
session's stable `onPermissionRequest` callback via `entry.current.permission`.

### Tiered auto-approval, then a deferred registry

```
onPermissionRequest(req)
  ├─ no req.toolCallId              → reject   (fail-safe, matches host)
  ├─ read of a user-attached path  → approve-once
  ├─ read of an OS temp file       → approve-once  (SDK tool output)
  └─ otherwise:
       PendingRequestRegistry.registerAndFire(toolCallId, () => confirm())
       confirm(): vscode_get_confirmation dialog
                  → respondOrBuffer(toolCallId, approved)
       → { kind: 'approve-once' } | { kind: 'reject' }
```

The registry (`src/util/pendingRequestRegistry.ts`, shared with Codex) keys
parked deferreds by `toolCallId`, so **concurrent** requests stay correlated and
`dispose()` can reject any outstanding prompts. Tiers 1 (session-internal
resource) and 4 (non-confirmation server tool) from the agent-host cascade are
N/A for the participant.

> Contrast: Claude uses a synchronous `canUseTool` callback (no registry needed);
> Copilot's `onPermissionRequest` is async, so the registry mirrors the Codex
> pattern.

---

## 7. Model Proxy — the differentiator

The built-in host-agent Copilot hands the GitHub token straight to the runtime,
so it is **CAPI-only**. Because this participant owns the client, it can insert a
proxy and route model calls to VS Code's LM API.

### Mechanism (env-var redirect — the proven Claude/Codex pattern)

When `copilotcli.modelProxy.enabled`, `_ensureClient()` spawns the runtime with:

```typescript
env = {
    ...process.env,
    COPILOT_API_URL: proxyInfo.responsesUrl,           // → localhost responses proxy
    GITHUB_COPILOT_API_TOKEN: proxyInfo.responsesNonce, // proxy auth
    COPILOT_CLI_DISABLE_WEBSOCKET_RESPONSES: 'true',    // force HTTP → no WS to intercept
};
```

The SDK documents this pair: *"Direct Copilot API authentication via the
`GITHUB_COPILOT_API_TOKEN` + `COPILOT_API_URL` environment-variable pair."* The
existing `responsesProxy` translates the runtime's OpenAI-Responses calls to VS
Code LM and **selects the model by the request body id**
(`vscode.lm.selectChatModels({ id })`).

### Dynamic, per-conversation model over one subprocess

The picked model flows **per session** via `createSession({ model: request.model.id })`
— not via the static `COPILOT_MODEL` env (which would pin one model for the whole
subprocess). So the single warm subprocess serves N conversations, each with its
own model.

| Approach | Per-conversation model? | 3rd-party? | Chosen |
|---|---|---|---|
| **env `COPILOT_API_URL` + per-session model** | ✅ (body carries model id) | ✅ via VS Code LM | ✅ |
| env-BYOK `COPILOT_MODEL` | ❌ static per subprocess | ✅ | ✗ |
| in-process `CopilotRequestHandler` | ✅ | ✅ | deferred (experimental, needs Fetch adapter) |

When the proxy is **disabled** (default), no env override is set — the runtime
calls CAPI directly with the GitHub token, identical to the built-in agent.

> Note: the setting is applied at client spawn; toggling it restarts the client
> when no sessions are active (or on window reload).

---

## 8. Agent Mode — per turn via slash commands

A chat participant has **no** agent-host `(mode, autoApprove)` "Set permission"
surface, and no portable proposed API for it (`ChatRequest.permissionLevel`
exists only in the *restricted* `chatParticipantPrivate` proposal; there is no
thinking-effort pick). So mode is chosen with leading slash commands and applied
per turn via `MessageOptions.agentMode`:

| Slash command | `agentMode` | Behaviour |
|---|---|---|
| `/plan` | `plan` | Propose a plan; no execution. `onExitPlanModeRequest` prompts before executing. |
| `/autopilot` | `autopilot` | Execute without approval prompts (SDK stops calling `onPermissionRequest`). |
| (none) | `interactive` | Execute; approvals go through `CopilotPermissionHandler`. |

`onExitPlanModeRequest` (first-class in SDK 1.0.4) surfaces the plan→execute
transition as a `vscode_get_confirmation` dialog.

Other slash commands:
- `/compact` → `session.rpc.history.compact()`, emit a confirmation, complete the
  turn without an SDK `send`.

---

## 9. Cancellation, Auth Rotation, Dispose

- **Cancellation**: `token.onCancellationRequested → session.abort()` (best-effort)
  then release the idle wait — the subprocess actually stops, unlike the old
  prototype which only rejected the local promise.
- **Token rotation**: `_ensureClient()` restarts the client when `_lastToken`
  changes and no sessions are active; the token's `rt=` field
  (`copilotTokenFields.ts`) gates restricted telemetry.
- **Dispose**: reject all pending permission deferreds, unsubscribe each session's
  event stream, clear `_sessions`, and `client.stop()`.

---

## 11. Shell Tool on Linux / WSL: `SHELL_SPAWN_BACKEND`

### The problem

The Copilot CLI's built-in shell tool uses the **MXC bubblewrap sandbox engine**
(`@microsoft/mxc-sdk/bin`) to execute shell commands in an isolated environment.
The VS Code host-agent distribution ships the MXC binaries and sets `MXC_BIN_DIR`
in the subprocess env so the CLI finds them. A standalone VS Code extension has
no MXC binaries in its `node_modules` (`@microsoft/mxc-sdk` is not present).

Without the sandbox engine the CLI tries to start a sandboxed shell, the sandbox
process never materialises, and the tool eventually surfaces as:

```
> ⚠️ Tool failed: timeout
```

### Confirmed environment (verified 2026-07-10)

| Check | Result |
|---|---|
| VS Code server node binary | ELF 64-bit Linux (`/home/iven/.vscode-server-insiders/.../node`) |
| `process.platform` | `linux` |
| `WSL_DISTRO_NAME` | `Ubuntu-22.04` |
| CLI binary resolved | `@github/copilot-linux-x64/copilot` (143 MB ELF) |
| `@microsoft/mxc-sdk` | **not present** in extension `node_modules` |

The subprocess is a **native Linux process** — not Windows. Paths like
`/home/iven/…` are accessible. The timeout is purely the missing sandbox engine.

### The fix: `SHELL_SPAWN_BACKEND` feature flag

On Linux, `_ensureClient()` sets:

```typescript
if (process.platform === 'linux') {
    env['COPILOT_CLI_ENABLED_FEATURE_FLAGS'] = [
        ...(existingFlags),
        'SHELL_SPAWN_BACKEND',
    ].join(',');
}
```

`SHELL_SPAWN_BACKEND` tells the CLI to use a **non-sandboxed pipe-based spawn**
for each shell command instead of the PTY-backed bubblewrap path. This works
correctly in both native Linux and WSL without any additional binaries.

The VS Code host agent (`copilotAgent.ts → _ensureClient`) sets the same flag on
Linux for the same reason:

```typescript
// VS Code host agent (copilotAgent.ts)
if (process.platform === 'linux') {
    flags.add('SHELL_SPAWN_BACKEND');
    env['COPILOT_CLI_ENABLED_FEATURE_FLAGS'] = [...flags].join(',');
}
```

### Other tool failures that are NOT sandbox-related

Some tool errors that appear alongside `timeout` are unrelated to the sandbox and
are caused by the model generating bad tool inputs:

| Error | Cause |
|---|---|
| `Search paths do not exist: /home/iven/*` | Model used a shell glob in a path arg; the CLI doesn’t expand globs, treats it as a literal (missing) path |
| `"view_range": Expected array, received null` | Model passed `null` for a parameter that requires an array |
| `Path does not exist` | Model hallucinated a file path that doesn’t exist in the workspace |

| Feature | Codex | Claude | Copilot |
|---|---|---|---|
| **Process model** | external app-server (JSON-RPC stdio) | in-process SDK spawns CLI | SDK spawns ONE runtime (stdio RPC) |
| **Message delivery** | event emitter (`ts.on()`) | async iterator (`for await`) | `session.on(handler)` typed events |
| **Session start** | `conn.startThread()` | first `query()` | `client.createSession()` |
| **Session resume** | `conn.resumeThread()` | `options.resume` | reuse entry / `client.resumeSession()` |
| **Warm process** | app-server stays up | `query()` cold; `WarmQuery` warm | **always warm** (session-native) |
| **Approval** | async RPC + registry | sync `canUseTool` | async `onPermissionRequest` + registry |
| **Cancellation** | `turn/interrupt` + await + timeout | `abortController.abort()` | `session.abort()` |
| **Mode / autopilot** | `approvalPolicy` | `permissionMode` | `MessageOptions.agentMode` via slash commands |
| **Model proxy** | env `proxyBaseUrl` → responses proxy | env `ANTHROPIC_BASE_URL` → messages proxy | env `COPILOT_API_URL` → responses proxy |
| **Model selection** | per turn (`startTurn({ model })`) | `Options.model` | per session (`createSession({ model })`) |
| **Local state** | approval registries, turn promises | AbortControllers, WarmQuery handles | session map, per-turn permission registries |

---

## 12. File Inventory

| File | Lines | Purpose |
|---|---|---|
| `src/copilotParticipant.ts` | ~393 | Main participant: client + session map, turn sequencer, routing, proxy env, slash commands, cancellation, dispose |
| `src/copilot/copilotSessionEventRouter.ts` | ~143 | Pure function: SDK `SessionEvent` → VS Code chat stream actions |
| `src/copilot/copilotPermissionHandler.ts` | ~111 | Tiered auto-approval + deferred registry keyed by `toolCallId` |
| `src/copilot/copilotAttachments.ts` | ~61 | VS Code references → SDK `MessageOptions.attachments` (file + selection) |
| `src/copilot/copilotTokenFields.ts` | ~34 | `parseCopilotTokenFields()` + `rt=` restricted-telemetry gate |
| `src/util/pendingRequestRegistry.ts` | ~124 | Shared deferred-promise registry (also used by Codex) |
| `src/proxy/responsesProxy.ts` | ~887 | OpenAI Responses API ↔ VS Code LM API translation (reused; backs the model proxy) |
