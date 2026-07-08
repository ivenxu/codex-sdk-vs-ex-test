# Claude Participant — Implementation Reference

## Overview

`ClaudeParticipant` is a VS Code chat participant that bridges VS Code Chat to
Claude Code via `@anthropic-ai/claude-agent-sdk`. It achieves near feature
parity with `CodexParticipant` while respecting fundamental architectural
differences (external app-server vs. in-process SDK).

---

## 1. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  One ClaudeParticipant instance                              │
│                                                              │
│  _sessions:  Map<sessionId, AbortController>                │
│              └── for canceling in-flight query() calls       │
│                                                              │
│  _warmSessions: Map<sessionId, SessionEntry>                │
│              └── for long-lived WarmQuery subprocesses       │
│                                                              │
│  _clientToolServer: shared singleton                        │
│              └── in-process MCP server for VS Code tools     │
└──────────────┬──────────────────────────────────────────────┘
               │
               │  ANTHROPIC_BASE_URL = http://127.0.0.1:N
               │  ANTHROPIC_AUTH_TOKEN = nonce.sessionId
               ▼
┌──────────────────────────────────────────────────────────────┐
│  Messages Proxy (src/proxy/messagesProxy.ts)                 │
│  Anthropic Messages API ←→ VS Code LM API                   │
│  Translates: text, tool_use, tool_result, thinking, SSE     │
└──────────────┬──────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────┐
│  @anthropic-ai/claude-agent-sdk                             │
│  Spawns claude CLI subprocess internally                     │
│  query()       → one-shot per turn (fresh spawn each time)   │
│  startup()     → WarmQuery (reusable across turns)           │
│  warm.query()  → sends prompt to running subprocess          │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Session Lifecycle

### Who owns sessions?

The **SDK** creates and persists sessions. Every call to `query()` or `startup()`
creates or resumes a session inside the SDK. The SDK writes history to
`CLAUDE_CONFIG_DIR/sessions/` (we override this to the extension's storage
path to isolate from VS Code's built-in Claude agent which uses `~/.claude`).

The participant only needs the `sessionId` string — returned by the SDK as
`msg.session_id` on every message — to pass as `options.resume` on the next
turn. No other session state is stored in the participant.

### Comparison with Codex

| Responsibility | Codex | Claude |
|---|---|---|
| **Create session** | `conn.startThread()` (RPC) | `query()` or `startup()` (SDK auto-creates) |
| **Persist history** | Codex app-server | SDK → `CLAUDE_CONFIG_DIR` |
| **Resume session** | `conn.resumeThread()` (RPC) | `options.resume = sessionId` |
| **Send prompt** | `conn.startTurn()` | `query({ prompt })` or `warmQuery.query(prompt)` |
| **Keep process alive** | App-server stays up between turns | `query()` spawns fresh each turn; `WarmQuery` keeps one alive |

### Session ID flow

```
TURN 1 (new session)
═══════════════════

handleRequest()
  ├─ findMetaInHistory() → undefined
  ├─ query({ prompt, options })
  │    options.resume → undefined (no resume)
  │
  │    SDK spawns claude CLI → creates session "abc-123"
  │
  │    for await (msg of q):
  │      msg.stream_event { session_id: "abc-123" }
  │      msg.assistant    { session_id: "abc-123" }
  │      msg.result       { session_id: "abc-123" }
  │
  │    routeSDKMessage() captures → routerState.sessionId = "abc-123"
  │
  ├─ finalSessionId = "abc-123"
  └─ return { metadata: { sessionId: "abc-123" } }
       │
       │ VS Code stores in conversation history
       ▼

TURN 2 (resume)
═══════════════

handleRequest()
  ├─ findMetaInHistory() → { sessionId: "abc-123" }
  ├─ buildClaudeOptions({ savedSessionId: "abc-123" })
  │    options.resume = "abc-123"  ← SDK loads history from disk
  └─ query({ prompt, options })
       SDK finds session "abc-123", loads history, continues
```

---

## 3. The Two Maps

### `_sessions: Map<sessionId, AbortController>`

| Purpose | Cancel in-flight `query()` calls |
|---|---|
| **Key** | `sessionId` — only stable identifier available |
| **Value** | `AbortController` passed as `options.abortController` |
| **Lifecycle** | Created when turn starts → deleted in `finally` block when turn ends |
| **Does NOT store session state** | Just the abort handle |

When user hits "Stop": `token.onCancellationRequested → ac.abort() → SDK kills subprocess`.

### `_warmSessions: Map<sessionId, SessionEntry>`

| Purpose | Reuse the same SDK subprocess across multiple turns |
|---|---|
| **Key** | `sessionId` |
| **Value** | `{ warmQuery, mcpServer, lastUsed, idleTimer }` |
| **Lifecycle** | Created via `_promoteToWarmQuery()` after first turn → disposed after 30 min idle |
| **Benefits** | Avoids ~1-2s cold-start per turn; required for steering |

Each entry wraps a `WarmQuery` handle:
```typescript
interface SessionEntry {
    warmQuery: WarmQuery;              // SDK handle to running subprocess
    mcpServer: ClientToolMcpServer | null;  // shared reference
    lastUsed: number;                  // for idle timeout tracking
    idleTimer?: NodeJS.Timeout;        // auto-dispose after inactivity
}
```

---

## 4. Promotion to WarmQuery

### Conditions (all must be true)

```typescript
if (finalSessionId && !this._warmSessions.has(finalSessionId)) {
    this._promoteToWarmQuery(options, finalSessionId);
}
```

1. **`finalSessionId` is truthy** — the turn succeeded and produced a session ID
2. **Not already in the pool** — `!_warmSessions.has(finalSessionId)` guards against duplicate promotion

### What happens

```typescript
async _promoteToWarmQuery(options, sessionId) {
    const warmQuery = await startup({
        options: { ...options, resume: sessionId }
    });
    // startup() spawns claude CLI, completes init handshake, returns handle
    // resume: sessionId loads existing conversation history

    this._warmSessions.set(sessionId, {
        warmQuery,
        mcpServer: this._clientToolServer,
        lastUsed: Date.now(),
        idleTimer: setTimeout(() => dispose, 30 * 60 * 1000),
    });
}
```

After promotion, subsequent turns hit the WarmQuery path:
```typescript
if (savedSessionId && this._warmSessions.has(savedSessionId)) {
    return this._handleWithWarmQuery(request, stream, token, options, savedSessionId, ac);
}
// Inside:
const q = await entry.warmQuery.query(request.prompt);
// No cold start — prompt sent directly to running subprocess
```

### Promotion is automatic

There's no config gate. Every session that completes successfully is promoted.
If promotion fails (e.g., `startup()` throws), the session falls back to
`query()` on the next turn — no harm done. The idle timer ensures unused
subprocesses are cleaned up without user intervention.

---

## 5. Subprocess Management

### query() path: 1 subprocess per turn

```
TURN 1: SDK spawns claude CLI → process exits when iterator ends
TURN 2: SDK spawns new claude CLI → process exits when iterator ends
...
```

The SDK handles all spawn/kill lifecycle. The only hook we have is the
`AbortController` for cancellation.

### WarmQuery path: 1 subprocess per session

```
TURN 1: query() → SDK spawns claude CLI → promotion → startup() keeps it alive
TURN 2: warmQuery.query() → sends to same process
TURN 3: warmQuery.query() → sends to same process
...
30 min idle → _disposeWarmSession() → warmQuery[Symbol.asyncDispose]() → SDK kills process
```

### Cleanup

```typescript
async _disposeWarmSession(sessionId) {
    const entry = this._warmSessions.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.idleTimer);
    this._warmSessions.delete(sessionId);
    try {
        await entry.warmQuery[Symbol.asyncDispose]();
        // SDK kills the claude CLI subprocess deterministically
    } catch {
        // Subprocess may already be dead; ignore
    }
}
```

The `WarmQuery` implements `AsyncDisposable` — calling `Symbol.asyncDispose`
tells the SDK to kill the subprocess cleanly. Without this call, the process
lingers until GC (non-deterministic).

### Multi-session scaling

A single `ClaudeParticipant` can serve N concurrent chat tabs:

```
_warmSessions:
  "abc-123" → WarmQuery A → claude CLI subprocess (pid: 48291)  ← Chat Tab 1
  "def-456" → WarmQuery B → claude CLI subprocess (pid: 51937)  ← Chat Tab 2
  "ghi-789" → (not promoted yet, using query() path)             ← Chat Tab 3
```

Each session gets its own `WarmQuery` → its own subprocess. The
`_clientToolServer` (in-process MCP server) is shared across all.

---

## 6. SDK Message Routing

The message router (`src/claude/claudeMessageRouter.ts`) is the bridge that
makes Claude feel like Codex in the VS Code chat UI. It converts SDK messages
to VS Code stream API calls:

```
SDK Message                              → VS Code Stream API
──────────────────────────────────────────────────────────────────────
stream_event.content_block_start         → stream.thinkingProgress(...)
  { type:'thinking' }
stream_event.content_block_delta         → stream.thinkingProgress(...)
  { type:'thinking_delta' }
stream_event.content_block_start         → stream.progress("Calling bash…")
  { type:'tool_use' }
stream_event.content_block_delta         → (silently ignored — raw JSON
  { type:'input_json_delta' }              is not user-friendly)
stream_event.content_block_delta         → stream.markdown(text)
  { type:'text_delta' }
stream_event.content_block_stop          → clear thinking/tool tracking
stream_event.message_delta               → accumulate token usage
result { subtype:'success' }             → capture usage + sessionId
result { subtype:'error_*' }             → display error
assistant                                → extract text → markdown
user                                     → clear active tool calls
system { subtype:'init' }                → log session init
```

The key enabler is `includePartialMessages: true` in `Options`. Without it,
the SDK only yields `assistant` (final combined response) and `result` (turn
result) — missing thinking blocks, tool call lifecycle events, and delta
streaming.

---

## 7. Options Builder

`buildClaudeOptions()` constructs the SDK `Options` object. All Options
flow through this single factory for consistency across `query()` and
`startup()` calls.

```typescript
buildClaudeOptions(input): Options {
    const options: Options = {
        cwd,                                  // workspace folder
        abortController: (set later),         // cancellation handle
        resume: input.savedSessionId,         // session persistence
        env: {
            ANTHROPIC_BASE_URL: proxyUrl,     // route through messages proxy
            ANTHROPIC_AUTH_TOKEN: nonce,      // proxy auth
            CLAUDE_CONFIG_DIR: storagePath,   // isolate from VS Code's Claude
        },
        includePartialMessages: true,          // unlock stream_event messages
        enableFileCheckpointing: true,         // safety: track file changes
        model: request.model.id,               // from VS Code chat picker
        allowDangerouslySkipPermissions: true, // delegate ALL to canUseTool
        canUseTool: (toolName, input, opts) => {
            // Single gate for all tool approvals
            // Shows vscode_get_confirmation dialog
        },
        onElicitation: (req) => {
            // Handle MCP server user-input requests
        },
    };
}
```

### Permission model

`allowDangerouslySkipPermissions: true` tells the SDK to bypass its own
internal permission rules and delegate **every** tool decision to `canUseTool`.
Without this flag, the SDK applies built-in rules for common tools (Bash, Read,
Edit) before consulting the callback — leading to tools being silently denied
without the user ever seeing a dialog.

The `canUseTool` callback:
1. Shows a VS Code confirmation dialog (`vscode_get_confirmation`)
2. Returns `{ behavior: 'allow' }` or `{ behavior: 'deny' }` based on user choice

No pending request registry is needed (unlike Codex) because `canUseTool` is
a synchronous callback — the SDK waits for the return value.

---

## 8. Dynamic Tools (Client-Tool MCP Server)

In-process MCP server (`src/claude/clientToolMcpServer.ts`) that registers
VS Code workspace tools as Claude-accessible tools via `createSdkMcpServer()`:

| Tool | Input | Implementation |
|---|---|---|
| `vscode_readFile` | `filePath` | `workspace.fs.readFile()` |
| `vscode_grepSearch` | `pattern`, `includePattern?`, `maxResults?` | `workspace.findTextInFiles()` |
| `vscode_fileSearch` | `pattern`, `maxResults?` | `workspace.findFiles()` |
| `vscode_listDirectory` | `directoryPath?` | `workspace.fs.readDirectory()` |
| `vscode_readLints` | `path?` | `languages.getDiagnostics()` |

Tools are namespaced with `vscode_` prefix to avoid collision with Claude's
built-in tools. The server is shared across all sessions (started once, lazily,
on first `handleRequest()`).

---

## 9. Comparison: Codex vs Claude Participant

| Feature | Codex | Claude |
|---|---|---|
| **Process model** | External app-server over JSON-RPC stdio | In-process SDK that spawns claude CLI |
| **Message delivery** | Event emitter (`ts.on()`) | Async iterator (`for await`) |
| **Session start** | RPC: `conn.startThread()` | Implicit: first `query()` without resume |
| **Session resume** | RPC: `conn.resumeThread()` | `options.resume = sessionId` |
| **Approval** | Async RPC + `PendingRequestRegistry` | Synchronous `canUseTool` callback |
| **Cancellation** | `conn.interruptTurn()` + await `turnDone` + timeout | `abortController.abort()` |
| **MCP** | Full lifecycle: inventory poll, tool call routing | SDK manages internally; `Options.mcpServers` |
| **Dynamic tools** | `DynamicToolManager` → app-server → RPC callback | In-process MCP server via `createSdkMcpServer()` |
| **Subprocess lifecycle** | App-server stays alive between turns | `query()` spawns fresh each turn; `WarmQuery` keeps alive |
| **State stored locally** | Approval registries, turn promises | AbortControllers (cancellation), WarmQuery handles (steering) |

---

## 10. File Inventory

| File | Lines | Purpose |
|---|---|---|
| `src/claudeParticipant.ts` | ~370 | Main participant: session management, turn lifecycle, routing |
| `src/claude/claudeMessageRouter.ts` | ~400 | Pure function: SDK messages → VS Code chat stream actions |
| `src/claude/claudeOptionsBuilder.ts` | ~200 | Factory: VS Code context → SDK Options |
| `src/claude/clientToolMcpServer.ts` | ~170 | 5 VS Code tools registered as in-process MCP server |
| `src/proxy/messagesProxy.ts` | ~500 | Anthropic Messages API ↔ VS Code LM API translation |
