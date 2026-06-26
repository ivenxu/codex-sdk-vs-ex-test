# VS Code Copilot CLI (Background Agent) — Architecture Deep Dive

**Date**: 2026-06-19  
**Status**: Research complete  
**Scope**: VS Code agent-host Copilot CLI / Background Agent integration, call chains, authentication, model sourcing, approval handling, and comparison to Codex and Claude.

---

## Table of Contents

1. [Overview](#1-overview)
2. [The `chatSessions` Extension Point](#2-the-chatsessions-extension-point--the-gating-mechanism)
3. [Agent-Host Registration](#3-agent-host-registration)
4. [Path B: Agent-Host Copilot CLI (`agent-host-copilotcli`)](#4-path-b-agent-host-copilot-cli)
5. [Authentication — GitHub Copilot Token (Direct)](#5-authentication--github-copilot-token-direct)
6. [Model Sourcing — SDK → CAPI](#6-model-sourcing--sdk--capi)
7. [Call Chain: Agent-Host Copilot CLI End-to-End](#7-call-chain-agent-host-copilot-cli-end-to-end)
8. [Comparison: Copilot CLI vs Codex vs Claude](#8-comparison-copilot-cli-vs-codex-vs-claude)
9. [Key Design Insights](#9-key-design-insights)

---

## 1. Overview

The Copilot CLI (Background Agent) is a **native VS Code agent-host provider** registered as session type `copilotcli` (extension contribution) and `agent-host-copilotcli` (agent-host session type). Unlike Codex and Claude:

- **Spawns a subprocess** running `@github/copilot/index.js` — a Node.js process connected via **stdio-based JSON-RPC** (not HTTP, not an in-process library)
- **Uses the GitHub Copilot token directly** — no nonce proxy layer needed
- **Supports Git worktree isolation** — optional, user-configurable per session
- **Has the richest mode set** among the three: `plan` mode, `interactive` mode, `autopilot` mode
- Registered **unconditionally** at agent-host startup (no additional gate like Codex/Claude)

### Session type IDs

| Layer | Session type |
|---|---|
| Extension contribution (`chatSessions` in copilot extension) | `'copilotcli'` |
| Agent-host local target | `'agent-host-copilotcli'` |
| `SessionType` constant | `SessionType.AgentHostCopilot = 'agent-host-copilotcli'` |
| Agent provider id | `CopilotAgent.id = 'copilotcli'` |

### Key comparison at a glance

| | Copilot CLI | Claude | Codex |
|---|---|---|---|
| **Subprocess spawned?** | ✅ Yes — `@github/copilot/index.js` (stdio-RPC) | ❌ No — in-process SDK | ✅ Yes — app-server (stdio-RPC) |
| **Auth proxy** | ❌ None — direct GitHub token | ✅ Nonce proxy | ✅ Nonce proxy |
| **Worktree isolation** | ✅ Optional | ❌ | ❌ |
| **Default enabled** | ✅ Unconditional | ✅ `true` | ❌ `false` |
| **Approval flow** | `onPermissionRequest` callback → deferred promise | `canUseTool` callback | JSON-RPC `requestApproval` |
| **Plan mode** | ✅ `'plan'` / `'interactive'` / `'autopilot'` | ✅ `permissionMode` | ❌ Not applicable |

---

## 2. The `chatSessions` Extension Point — The Gating Mechanism

### Extension contribution

**File**: `extensions/copilot/package.json` (lines ~6770+)

```json
{
  "type": "copilotcli",
  "name": "cli",
  "displayName": "Copilot CLI",
  "icon": "$(copilot)",
  "welcomeTitle": "Copilot CLI",
  "welcomeMessage": "Run tasks in the background with the Copilot CLI, type `#` for adding context",
  "inputPlaceholder": "Run tasks in the background with the Copilot CLI, type `#` for adding context",
  "order": 1,
  "canDelegate": true,
  "description": "%github.copilot.session.providerDescription.background%",
  "when": "config.github.copilot.chat.backgroundAgent.enabled",
  "supportsAutoModel": true,
  "capabilities": {
    "supportsFileAttachments": true,
    "supportsProblemAttachments": true,
    "supportsToolAttachments": false,
    "supportsImageAttachments": true,
    "supportsSymbolAttachments": true,
    "supportsSearchResultAttachments": true,
    "supportsSourceControlAttachments": true,
    "supportsPromptAttachments": true,
    "supportsHandOffs": true
  }
}
```

**Key attributes**:
- `canDelegate: true` — enables Mode B registration (routes to agent-host `copilotcli` provider)
- `supportsAutoModel: true` — integrates with chat's auto-model selection
- `when: "config.github.copilot.chat.backgroundAgent.enabled"` — UI visibility gate

### What `canDelegate: true` triggers in the workbench

**File**: `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostChatContribution.ts`

```typescript
const LOCAL_AGENT_HOST_SESSION_TYPE_PREFIX = 'agent-host-';
// ...
function getLocalAgentHostProviderForSessionType(sessionType: string): AgentProvider | undefined {
    // 'agent-host-copilotcli'.slice(11) === 'copilotcli'
    return sessionType.slice(LOCAL_AGENT_HOST_SESSION_TYPE_PREFIX.length) || undefined;
}
```

When the copilot extension contributes `copilotcli` with `canDelegate: true`:
1. `_enableContribution()` finds `contribution.canDelegate === true`
2. Calls `_registerAgent(provider='copilotcli')` → `chatAgentService.registerDynamicAgent()`
3. Creates `AgentHostSessionHandler` with session type `'agent-host-copilotcli'`
4. Creates `AgentHostLanguageModelProvider` for the in-session model picker

### `SessionType` constants

**File**: `src/vs/workbench/contrib/chat/common/chatSessionsService.ts:306`

```typescript
export namespace SessionType {
    export const AgentHostCopilot = 'agent-host-copilotcli';
    export const AgentHostClaude  = 'agent-host-claude';
    export const AgentHostCodex   = 'agent-host-codex';
}
```

---

## 3. Agent-Host Registration

### Startup — `agentHostMain.ts`

**File**: `src/vs/platform/agentHost/node/agentHostMain.ts`

```typescript
// CopilotAgent is registered UNCONDITIONALLY at startup
agentService.registerProvider(instantiationService.createInstance(CopilotAgent));

// Claude and Codex are gated — CopilotCLI is NOT
if (isAgentEnabled(process.env[AgentHostClaudeAgentEnabledEnvVar], true) && ...) {
    agentService.registerProvider(instantiationService.createInstance(ClaudeAgent));
}
if (isAgentEnabled(process.env[AgentHostCodexAgentEnabledEnvVar], false) && ...) {
    agentService.registerProvider(instantiationService.createInstance(CodexAgent));
}
```

**CopilotAgent is the only agent registered with no gate**. This reflects its status as the "core" background agent — always available once the agent-host starts.

The UI visibility gate (`config.github.copilot.chat.backgroundAgent.enabled`) is enforced at the workbench layer (the `when` expression in the `chatSessions` contribution), not in the agent-host.

### `CopilotAgent` class definition

**File**: `src/vs/platform/agentHost/node/copilot/copilotAgent.ts`

```typescript
export class CopilotAgent extends Disposable implements IAgent {
    readonly id = 'copilotcli' as const;    // line ~273
    
    getDescriptor(): IAgentDescriptor {
        return {
            provider: 'copilotcli',         // line ~429
            displayName: 'Copilot CLI',
            description: 'Copilot SDK agent running in a dedicated process',
        };
    }
    
    getProtectedResources(): ProtectedResourceMetadata[] {
        return [GITHUB_COPILOT_PROTECTED_RESOURCE];  // declares GitHub Copilot token required
    }
}
```

---

## 4. Path B: Agent-Host Copilot CLI (`agent-host-copilotcli`)

### 4.1 Startup gate (agent-host process)

Unlike Claude (enabled by default, gated on SDK availability) and Codex (disabled by default), CopilotAgent has **no process-level gate**. It is always instantiated. The only checks are:

1. **Authentication gate**: `GITHUB_COPILOT_PROTECTED_RESOURCE` declared → workbench prompts for Copilot auth before sessions can be created
2. **Feature gate**: `config.github.copilot.chat.backgroundAgent.enabled` in the extension's `when` expression → controls UI visibility

### 4.2 Workbench registration chain

```
CopilotAgent registered in agent-host process (unconditional)
    ↓
agentHostChatContribution._onDidChangeRootState fires
    ↓
_shouldRegisterAgent('copilotcli') → true
    ↓
_registerAgent('copilotcli'):
    sessionType = 'agent-host-copilotcli'
    ↓
    chatSessionsService.registerChatSessionContribution({
        type: 'agent-host-copilotcli', canDelegate: true
    })
    ↓
    agentData = { id: 'agent-host-copilotcli', ... }
    chatAgentService.registerDynamicAgent(agentData, { invoke: _invokeAgent })
    ↓
    AgentHostLanguageModelProvider created
    languageModelsService.registerLanguageModelProvider('copilotcli', provider)
    ↓
    'Copilot CLI' appears in session picker
```

### 4.3 `_ensureClient()` → Spawn the CLI subprocess

**File**: `src/vs/platform/agentHost/node/copilot/copilotAgent.ts` (~line 602)

This is the **first time a subprocess is spawned** — lazily, on first session creation.

```typescript
private async _ensureClient(): Promise<CopilotClient> {
    if (this._client) { return this._client; }
    if (!this._githubToken) {
        throw new ProtocolError(AHP_AUTH_REQUIRED, 'Authentication required');
    }
    
    // 1. Build subprocess environment
    const env: Record<string, string | undefined> = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    // Strip VS Code / Electron vars that interfere with Node
    delete env['NODE_OPTIONS'];
    delete env['VSCODE_INSPECTOR_OPTIONS'];
    delete env['VSCODE_ESM_ENTRYPOINT'];
    delete env['VSCODE_HANDLES_UNCAUGHT_ERRORS'];
    
    // SDK-specific vars
    env['COPILOT_CLI_RUN_AS_NODE'] = '1';
    env['USE_BUILTIN_RIPGREP'] = 'false';
    env['COPILOT_MCP_APPS'] = 'true';
    
    // Linux: force spawn-based shell backend for sandbox compatibility
    if (process.platform === 'linux') {
        const flags = new Set((env['COPILOT_CLI_ENABLED_FEATURE_FLAGS'] ?? '').split(','));
        flags.add('SHELL_SPAWN_BACKEND');
        env['COPILOT_CLI_ENABLED_FEATURE_FLAGS'] = [...flags].join(',');
    }
    
    // Optional rubber duck mode
    if (this._isRubberDuckEnabled()) {
        env['RUBBER_DUCK_AGENT'] = 'true';
    }
    
    // 2. Resolve CLI entry point
    const nodeModulesUri = URI.joinPath(FileAccess.asFileUri(''), '..', 'node_modules');
    const cliPath = URI.joinPath(nodeModulesUri, '@github', 'copilot', 'index.js').fsPath;
    
    // 3. Add ripgrep to PATH
    const resolvedRgDiskPath = await rgDiskPath();
    const rgDir = dirname(resolvedRgDiskPath);
    env[PATH_KEY] = currentPath ? `${currentPath}:${rgDir}` : rgDir;
    
    // 4. Create client
    const client = this._createCopilotClient({
        gitHubToken: this._githubToken,
        useLoggedInUser: false,
        connection: RuntimeConnection.forStdio({ path: cliPath }),  // ← stdio IPC
        env,
        telemetry,
        logLevel: copilotCliLogLevelFor(this._logService.getLevel()),
        enableRemoteSessions: this._isSessionSyncEnabled(),
    });
    await client.start();
    this._client = client;
    return client;
}
```

**`RuntimeConnection.forStdio({ path: cliPath })`** — this spawns `node @github/copilot/index.js` and sets up JSON-RPC communication over stdout/stdin. The subprocess is a separate Node.js process.

**Ripgrep on PATH** — the CLI subprocess needs `rg` (ripgrep) for file search operations. The agent-host resolves VS Code's bundled ripgrep binary and prepends its directory to `PATH`.

**MXC sandbox binaries**:
```typescript
env['MXC_BIN_DIR'] = URI.joinPath(nodeModulesUri, '@microsoft', 'mxc-sdk', 'bin').fsPath;
```
These provide the sandbox engine (`agentHostSandboxEngine.ts`) with native binaries for restricted shell execution.

### Plan mode shim

**File**: `src/vs/platform/agentHost/node/copilot/copilotAgent.ts` (~line 588)

The `@github/copilot-sdk` doesn't yet expose `onExitPlanMode` publicly, so agent-host injects it:

```typescript
protected _enablePlanModeOnClient(client: CopilotClient): void {
    const connection = (client as unknown as { connection: { sendRequest: Function } }).connection;
    const originalSendRequest = connection.sendRequest.bind(connection);
    connection.sendRequest = (method: string, params: unknown) => {
        if ((method === 'session.create' || method === 'session.resume') && params && typeof params === 'object') {
            return originalSendRequest(method, { ...(params as Record<string, unknown>), requestExitPlanMode: true });
        }
        return originalSendRequest(method, params);
    };
}
```

This monkey-patches the SDK's JSON-RPC layer to inject `requestExitPlanMode: true` into every `session.create` and `session.resume` call.

### 4.4 Session creation (provisional)

**File**: `src/vs/platform/agentHost/node/copilot/copilotAgent.ts` (~line 1250)

```typescript
async createSession(config?: IAgentCreateSessionConfig): Promise<IAgentCreateSessionResult> {
    const sessionId = config?.session ? AgentSession.id(config.session) : generateUuid();
    const workingDirectory = await this._resolveCreateWorkingDirectory(config, sessionId);
    
    // Ensure the CLI subprocess is running (lazy start)
    const client = await this._ensureClient();
    
    // Store provisional — no SDK session created yet
    this._provisionalSessions.set(sessionId, {
        sessionId,
        sessionUri,
        workingDirectory,
        model: config?.model,      // user's model selection
        agent: config?.agent,      // user's agent/mode selection
        project,                   // git project metadata
    });
    
    return { session: sessionUri, provisional: true, workingDirectory };
}
```

**`IProvisionalSession`** stores:
- `sessionId` — UUID
- `sessionUri` — `agent://copilotcli/<sessionId>`
- `workingDirectory` — workspace root
- `model` — model selection (updated by `changeModel`)
- `agent` — agent selection (updated by `changeAgent`)
- `project` — git project info (branch, remote, etc.)

**Note**: `_ensureClient()` is called here, so the CLI subprocess spawns on first `createSession()` — not lazily on first message (unlike Claude). But the SDK **session** itself is not created until the first message.

### 4.5 Materialization (on first message)

**File**: `src/vs/platform/agentHost/node/copilot/copilotAgent.ts` (~line 1670)

```typescript
async sendMessage(session: URI, prompt: string, attachments?: ..., turnId?: string): Promise<void> {
    const sessionId = AgentSession.id(session);
    await this._sessionSequencer.queue(sessionId, async () => {
        // First message: promote provisional → live session
        let entry: CopilotAgentSession | undefined;
        if (this._provisionalSessions.has(sessionId)) {
            entry = await this._materializeProvisional(sessionId, prompt);
        } else {
            entry = this._sessions.get(sessionId);
        }
        
        // Emit pending first-turn announcement (e.g., "Created worktree at ...")
        const announcement = this._pendingFirstTurnAnnouncements.get(sessionId);
        if (announcement !== undefined) {
            this._pendingFirstTurnAnnouncements.delete(sessionId);
            entry.emitInitialMarkdown(announcement);
        }
        
        const sdkMode = this._resolveSdkMode(session);
        await entry.send(prompt, attachments, turnId, sdkMode);
    });
}
```

**`_materializeProvisional(sessionId, prompt)`**:
1. Reads the provisional session entry
2. Optionally creates a **Git worktree** (if `isolation='worktree'` configured)
   - Branch derived from first message text: `agents/<sanitized-slug>-<8-char-uuid>`
3. Creates a `CopilotAgentSession` wrapper
4. Calls SDK's `client.session.create(...)` to establish the SDK session via JSON-RPC
5. Moves entry from `_provisionalSessions` to `_sessions`

**Git worktree announcement** — if a worktree is created, a markdown message is queued as `_pendingFirstTurnAnnouncements` and emitted at turn start before the AI response.

### 4.6 Mode translation

**File**: `src/vs/platform/agentHost/node/copilot/copilotAgent.ts` (~line 1750)

Translates the VS Code `(mode, autoApprove)` session config pair to the SDK's three-value mode:

```typescript
private _resolveSdkMode(session: URI): CopilotSdkMode | undefined {
    const sessionKey = session.toString();
    const mode = this._configurationService.getEffectiveValue(
        sessionKey, platformSessionSchema, SessionConfigKey.Mode
    );
    if (mode === 'plan') {
        return 'plan';
    }
    if (mode === 'interactive') {
        const autoApprove = this._configurationService.getEffectiveValue(
            sessionKey, platformSessionSchema, SessionConfigKey.AutoApprove
        );
        return autoApprove === 'autopilot' ? 'autopilot' : 'interactive';
    }
    return undefined;
}
```

| VS Code `mode` | VS Code `autoApprove` | SDK mode | Behaviour |
|---|---|---|---|
| `'plan'` | any | `'plan'` | Planning mode — proposes steps, no execution |
| `'interactive'` | `'autopilot'` | `'autopilot'` | Executes without asking for approval |
| `'interactive'` | `'default'` or `'autoApprove'` | `'interactive'` | Asks for approval as needed |

### 4.7 Message dispatch — `send()`

**File**: `src/vs/platform/agentHost/node/copilot/copilotAgentSession.ts` (~line 1950)

```typescript
async send(
    prompt: string,
    attachments?: readonly MessageAttachment[],
    turnId?: string,
    mode?: CopilotSdkMode
): Promise<void> {
    if (turnId) {
        this._turnId = turnId;
    }
    
    // Parse leading slash commands (/compact, /plan, /rubber-duck)
    const slashCommand = parseLeadingSlashCommand(prompt);
    if (slashCommand?.command === 'compact') {
        await this._wrapper.session.rpc.history.compact();
        this.emitInitialMarkdown(localize('copilotAgent.compactionCompleted', "Compaction completed"));
        this._completeActiveTurn();
        return;
    }
    
    // Convert VS Code attachments to SDK format
    const sdkAttachments = attachments?.length
        ? (await Promise.all(attachments.map(a => this._toSdkAttachment(a)))).filter(isDefined)
        : undefined;
    
    // Apply mode (sets CLI subprocess's internal state via JSON-RPC)
    await this.applyMode(mode);
    
    // Forward to CLI subprocess via JSON-RPC
    await this._wrapper.session.send({
        prompt,
        attachments: sdkAttachments?.length ? sdkAttachments : undefined,
    });
}
```

`this._wrapper.session.send()` issues a JSON-RPC call over stdio to the CLI subprocess:

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "session.send",
  "params": {
    "prompt": "Create a login form",
    "attachments": [...]
  }
}
```

The subprocess processes the message, runs LLM inference via CAPI, and streams events back over stdio.

### 4.8 Streaming events → VS Code Chat UI

**File**: `src/vs/platform/agentHost/node/copilot/mapSessionEvents.ts`

The Copilot CLI SDK emits structured **session events** (not raw SSE). These are wrapped by `CopilotSessionWrapper` and mapped to VS Code protocol actions:

#### SDK event types → VS Code actions

| SDK event | Handler | VS Code action | UI effect |
|---|---|---|---|
| `assistant.message` | `_handleMessage()` | `ChatMarkdownChunk` | Opens new assistant turn |
| `assistant.message_delta` | `_emitMarkdownDelta()` | `ChatMarkdownChunk` (streaming) | Incremental markdown text |
| `assistant.reasoning` | mapped | `ChatMarkdownChunk` (thinking) | Thinking bubble |
| `assistant.reasoning_delta` | mapped | `ChatMarkdownChunk` delta | Incremental reasoning text |
| `assistant.usage` | mapped | `ChatTokenUsageUpdate` | Token usage display |
| `tool.execution_start` | `_handleToolStart()` | `ChatToolCallStart` | Tool call badge opens |
| `tool.execution_partial_result` | mapped | `ChatToolCallOutput` | Partial tool output streams |
| `tool.execution_complete` | `_handleToolComplete()` | `ChatToolCallEnd` | Tool call badge closes |
| `skill.invoked` | mapped | `ChatMarkdownChunk` | Skill usage annotation |
| `subagent.started` | mapped | `ChatSubagentStart` | Subagent delegation indicator |
| `session.idle` | `_completeActiveTurn()` | `ChatTurnComplete` | Turn finalized |
| `session.usage_info` | mapped | `ChatTokenUsageUpdate` | Session-level usage |
| `user.message` | mapped | No UI action (echo suppressed) | Internal tracking only |

#### `CopilotSessionWrapper` event surface

**File**: `src/vs/platform/agentHost/node/copilot/copilotSessionWrapper.ts`

```typescript
export class CopilotSessionWrapper extends Disposable {
    constructor(readonly session: CopilotSession) { super(); }
    
    get onMessageDelta(): Event<SessionEventPayload<'assistant.message_delta'>> { ... }
    get onToolStart(): Event<SessionEventPayload<'tool.execution_start'>> { ... }
    get onToolComplete(): Event<SessionEventPayload<'tool.execution_complete'>> { ... }
    get onIdle(): Event<SessionEventPayload<'session.idle'>> { ... }
    // ... 40+ event getters total
}
```

The wrapper converts the SDK's EventEmitter-based API to VS Code `Event<T>` (using `Emitter`).

#### Comparison with Codex and Claude streaming

| Dimension | Copilot CLI | Claude | Codex |
|---|---|---|---|
| **Event origin** | SDK events from CLI subprocess (JSON-RPC) | Anthropic SSE (HTTP chunked) from proxy | Notification RPCs from app-server (JSON-RPC) |
| **Streaming protocol** | Named events (`assistant.message_delta`, etc.) | SSE with typed `content_block_delta` | Named notifications (`item/agentMessage/delta`, etc.) |
| **Mapping layer** | `mapSessionEvents.ts` | `claudeSdkMessageRouter.ts` | `codexMapAppServerEvents.ts` |
| **Turn completion** | `session.idle` event | `message_stop` SSE event | `turn/completed` notification |

### 4.9 Approval handling

The Copilot CLI approval system uses an **`onPermissionRequest` callback** from the SDK, with a `_pendingPermissions` deferred-promise registry.

---

#### Permission request flow

When the CLI subprocess needs to perform a sensitive operation (shell command, file write, etc.), it sends an `onPermissionRequest` callback to the agent-host:

```
CLI subprocess requests to run: bash -c "npm install"
    ↓
SDK fires onPermissionRequest callback
    ↓
copilotAgentSession._handlePermissionRequest(request: ITypedPermissionRequest)
```

**`_handlePermissionRequest()` — 5-tier auto-approval check**:

```typescript
// copilotAgentSession.ts ~line 2130
private async _handlePermissionRequest(
    request: ITypedPermissionRequest
): Promise<PermissionRequestResult> {
    const toolCallId = request.toolCallId;
    if (!toolCallId) { return { kind: 'reject' }; }  // safety: require ID
    
    // Tier 1: Session-internal resources (auto-approve)
    if (this._getInternalSessionResourcePath(request)) {
        return { kind: 'approve-once' };
    }
    
    // Tier 2: User-attached files (read requests → auto-approve)
    if (request.kind === 'read' && this._isSessionAttachmentPath(request.path)) {
        return { kind: 'approve-once' };
    }
    
    // Tier 3: Copilot SDK temp files (auto-approve)
    if (request.kind === 'read' && isCopilotSdkToolOutputTempFile(request.path, tmpDir)) {
        return { kind: 'approve-once' };
    }
    
    // Tier 4: Non-confirmation server tools (auto-approve)
    if (request.kind === 'custom-tool' && this._serverToolHost?.toolNames.includes(request.toolName)
        && !this._serverToolHost.requiresConfirmation(request.toolName)) {
        return { kind: 'approve-once' };
    }
    
    // Tier 5: Sandboxed shell (sandbox engine decides)
    if (isShellRequest && await this._isShellSandboxedByDefault()) {
        return { kind: 'approve-once' };  // sandbox handles it
    }
    
    // Requires user approval: park on deferred
    const deferred = new DeferredPromise<boolean>();
    this._pendingPermissions.set(toolCallId, deferred);
    
    // Emit ChatToolCallReady to VS Code chat UI
    this._fire(session.sessionUri, {
        type: ActionType.ChatToolCallReady,
        toolCallId,
        confirmationTitle: request.reason ?? request.kind,
        toolInput: JSON.stringify(request),
    });
    
    const approved = await deferred.p;
    return approved ? { kind: 'approve-once' } : { kind: 'reject' };
}
```

**`_pendingPermissions` map**:

```typescript
// copilotAgentSession.ts ~line 625
private readonly _pendingPermissions = new Map<string, DeferredPromise<boolean>>();
```

#### User response flow

```
VS Code chat UI shows approval card ("Run shell command: npm install?")
    ↓
User clicks "Allow" or "Deny"
    ↓
ChatToolCallConfirmed action dispatched
    ↓
agentSideEffects.handleAction(ChatToolCallConfirmed):
    agent.respondToPermissionRequest(action.toolCallId, action.approved)
    ↓
CopilotAgent.respondToPermissionRequest(requestId, approved):
    // Iterate all sessions, find the matching pending deferred
    if (session.respondToPermissionRequest(requestId, approved)) { return; }
    ↓
copilotAgentSession.respondToPermissionRequest(toolCallId, approved):
    const deferred = this._pendingPermissions.get(toolCallId);
    if (!deferred) { return false; }
    this._pendingPermissions.delete(toolCallId);
    deferred.resolve(approved);   // ← unblocks _handlePermissionRequest
    return true;
    ↓
_handlePermissionRequest() returns { kind: 'approve-once' | 'reject' }
    ↓
SDK proceeds with or skips the shell command
```

#### Permission request types

| `request.kind` | What it guards | Auto-approved? |
|---|---|---|
| `'read'` | File/directory read | Yes (if session resource, attachment, or SDK temp file) |
| `'write'` | File/directory write | Depends on sandbox config |
| `'shell'` | Shell command execution | Yes (if sandboxed by default) |
| `'custom-tool'` | MCP tool / server tool | Yes (if non-confirmation server tool) |

#### How the VS Code "Set permission" picker affects Copilot CLI

The picker (`Default Approvals / Bypass Approvals / Autopilot`) dispatches `SessionConfigChanged { [SessionConfigKey.AutoApprove]: level }`. For Copilot CLI:

- **`_resolveSdkMode()`** reads `SessionConfigKey.AutoApprove === 'autopilot'` → sets SDK mode to `'autopilot'` → **SDK never sends `onPermissionRequest`** (handles everything internally)
- **`SessionPermissionManager.getAutoApproval()`** in `agentSideEffects._handleToolReady()` handles the `pending_confirmation` path
- **For `onPermissionRequest` callbacks**: NOT routed through `_handleToolReady()` — handled directly by `_handlePermissionRequest()` in `copilotAgentSession.ts`

**Important**: The `'autopilot'` SDK mode is the most complete bypass — the CLI subprocess itself stops asking for approval. The VS Code-level `SessionPermissionManager` only handles a subset of Copilot CLI's tool approvals.

### 4.10 Session persistence

**File**: `src/vs/platform/agentHost/node/copilot/copilotSessionWrapper.ts`

The SDK (`@github/copilot`) maintains its own session state on disk. VS Code's agent-host stores minimal metadata in `_sessions` map (in-memory) and in the `sessionDatabase` (for session listing).

On session restart:
- `provideChatSessionContent()` reads history via `client.getSessionMessages(sessionId)` (SDK call over stdio JSON-RPC)
- History mapped to VS Code turns via `mapSessionEvents.ts`

---

## 5. Authentication — GitHub Copilot Token (Direct)

Unlike Claude and Codex (which use a localhost nonce proxy), Copilot CLI passes the GitHub token **directly to the SDK subprocess**:

```typescript
// copilotAgent.ts — _ensureClient()
const client = this._createCopilotClient({
    gitHubToken: tokenAtStartup,   // ← direct GitHub Copilot token
    useLoggedInUser: false,
    connection: RuntimeConnection.forStdio({ path: cliPath }),
    env,
    ...
});
```

The `gitHubToken` is passed as a `CopilotClientOptions` field. The SDK subprocess uses it to authenticate with the Copilot API directly.

### Token field parsing

**File**: `src/vs/platform/agentHost/node/copilot/copilotTokenFields.ts`

The Copilot token carries structured metadata in a header before the HMAC:

```
<key1>=<value1>;<key2>=<value2>;...:HMAC
```

Example: `tid=abc123;exp=1700000000;rt=1:HMACvalue`

```typescript
export function parseCopilotTokenFields(token: string | undefined): ReadonlyMap<string, string> {
    const colonIdx = token.indexOf(':');
    const header = colonIdx === -1 ? token : token.substring(0, colonIdx);
    const result = new Map<string, string>();
    for (const field of header.split(';')) {
        const eqIdx = field.indexOf('=');
        if (eqIdx <= 0) continue;
        result.set(field.substring(0, eqIdx), field.substring(eqIdx + 1));
    }
    return result;
}
```

**`rt` field — telemetry gate**:

```typescript
export function isRestrictedTelemetryEnabled(token: string | undefined): boolean {
    return parseCopilotTokenFields(token).get('rt') === '1';
}
```

When `rt=1` in the token, the agent-host logs enhanced telemetry to GitHub. This is checked in `CopilotAgent.authenticate()`:

```typescript
async authenticate(resource: string, token: string): Promise<boolean> {
    const tokenChanged = this._githubToken !== token;
    this._githubToken = token;
    this._updateRestrictedTelemetry(token);  // reads 'rt' field
    if (tokenChanged && this._client && this._sessions.size === 0) {
        await this._stopClient();  // restart subprocess with new token
    }
    if (tokenChanged) { void this._refreshModels(); }
    return true;
}
```

### Authentication comparison

| Dimension | Copilot CLI | Claude | Codex |
|---|---|---|---|
| **Token type** | GitHub Copilot token (JWT-like) | GitHub Copilot token | GitHub Copilot token |
| **Token delivery** | Direct to SDK via `CopilotClientOptions.gitHubToken` | Via localhost nonce proxy | Via localhost nonce proxy |
| **Proxy layer** | ❌ None | ✅ `ClaudeProxyService` (nonce) | ✅ `CodexProxyService` (nonce) |
| **Subprocess sees** | GitHub token directly | Nonce (not GitHub token) | Nonce (not GitHub token) |
| **Token rotation** | `authenticate()` restarts subprocess if token changed | `authenticate()` restarts proxy | `authenticate()` restarts proxy |

---

## 6. Model Sourcing — SDK → CAPI

Unlike Codex (which uses `copilotApiService.models()` + filtering) and Claude (same), Copilot CLI fetches model list **through the SDK subprocess**:

**File**: `src/vs/platform/agentHost/node/copilot/copilotAgent.ts` (~line 1200)

```typescript
private async _listModels(): Promise<IAgentModelInfo[]> {
    const client = await this._ensureClient();
    const models = await client.listModels();    // ← JSON-RPC to CLI subprocess
    return models.map((m): IAgentModelInfo => ({
        provider: this.id,
        id: m.id,
        name: m.name,
        maxContextWindow: m.capabilities?.limits?.max_context_window_tokens,
        supportsVision: !!m.capabilities?.supports?.vision,
        configSchema: this._createModelConfigSchema(m),
        policyState: m.policy?.state as PolicyState | undefined,
        _meta: this._createModelPricingMeta(m.billing),
    }));
}
```

`client.listModels()` sends a `models.list` JSON-RPC call to the CLI subprocess, which queries the Copilot API and returns the full model catalog. Each model includes:

- `id` — unique model ID (e.g. `'gpt-4.1'`, `'claude-sonnet-4-5'`)
- `name` — display name
- `capabilities.limits.max_context_window_tokens` — context window size
- `capabilities.supports.vision` — vision support flag
- `billing.tokenPrices` — pricing tiers (for model picker hover display)
- `policy.state` — usage policy (`'available'` / `'blocked'` / etc.)

**Model sourcing comparison**:

| Dimension | Copilot CLI | Claude | Codex |
|---|---|---|---|
| **List call** | `client.listModels()` (SDK → CLI subprocess → CAPI) | `copilotApiService.models()` (direct CAPI) | `copilotApiService.models()` (direct CAPI) |
| **Filter** | None — returns all from CAPI | `vendor='Anthropic'` + `/v1/messages` | `/responses` endpoint support |
| **Model variety** | All CAPI models (GPT, Claude, Gemini, etc.) | Anthropic only | OpenAI-family only |
| **Pricing metadata** | ✅ `billing.tokenPrices` | ❌ Not extracted | ❌ Not extracted |

---

## 7. Call Chain: Agent-Host Copilot CLI End-to-End

### Initialization

```
VS Code starts → agentHostMain.ts
    ↓
agentService.registerProvider(CopilotAgent)  [unconditional]
    ↓
agentHostChatContribution detects 'copilotcli' provider
    → registers 'agent-host-copilotcli' session type
    → registers AgentHostLanguageModelProvider
    → registers dynamic agent
    ↓
CopilotAgent.authenticate(GITHUB_COPILOT_PROTECTED_RESOURCE, githubToken)
    → this._githubToken = githubToken
    → _refreshModels()
```

### CLI subprocess startup (lazy — on first `createSession()`)

```
User opens 'agent-host-copilotcli' session
    ↓
chatAgentService.invokeAgent('agent-host-copilotcli', ...)
    ↓
AgentHostSessionHandler._invokeAgent → IPC → ChatTurnStarted action
    ↓
ClaudeAgent (sic CopilotAgent).createSession(config)
    ↓
_ensureClient():
    Build env (strip Electron vars, add COPILOT_CLI_RUN_AS_NODE=1, etc.)
    Resolve: @github/copilot/index.js
    Add ripgrep to PATH
    RuntimeConnection.forStdio({ path: cliPath })
    → spawns: node @github/copilot/index.js
    ← establishes stdio JSON-RPC channel
    await client.start()
    ↓
_provisionalSessions.set(sessionId, { ..., model, project })
```

### First message (materialization)

```
User sends: "Create a login form with React"
    ↓
CopilotAgent.sendMessage(sessionUri, prompt, attachments, turnId)
    ↓
_sessionSequencer.queue(sessionId, async () => {
    _materializeProvisional(sessionId, prompt):
        → [optionally] create Git worktree
            branch: agents/create-login-form-<8-char-id>
            emit: "Created worktree at /path/..." (first-turn announcement)
        → client.session.create({
              sessionId,
              model: selectedModel.id,
              workingDirectory: workingDir.fsPath,
              ...
          })  ← JSON-RPC to CLI subprocess
        → CopilotAgentSession created, moved to _sessions
    
    entry.emitInitialMarkdown(worktreeAnnouncement)  // if worktree created
    
    sdkMode = _resolveSdkMode(session)  // 'plan' | 'autopilot' | 'interactive'
    
    entry.send(prompt, attachments, turnId, sdkMode)
        ↓
        applyMode('interactive')  // JSON-RPC: session.setMode
        ↓
        wrapper.session.send({ prompt, attachments })
        ← JSON-RPC: session.send → CLI subprocess → LLM inference
})
```

### Streaming response

```
CLI subprocess sends JSON-RPC notifications:
    { "method": "session.event", "params": { "type": "assistant.message", ... } }
    { "method": "session.event", "params": { "type": "assistant.message_delta", "content": "I'll" } }
    { "method": "session.event", "params": { "type": "tool.execution_start", "name": "bash", ... } }
    ...
    ↓
CopilotSessionWrapper fires typed Event<T> for each event
    ↓
CopilotAgentSession._subscribeToEvents() handlers
    ↓
mapSessionEvents() → Turn protocol actions
    ↓
VS Code chat UI updates (text, tool badges, thinking, etc.)
```

### Approval (if needed)

```
CLI subprocess sends: onPermissionRequest(toolCallId, { kind: 'shell', command: 'npm install' })
    ↓
copilotAgentSession._handlePermissionRequest():
    5-tier auto-approval check → needs user approval
    _pendingPermissions.set(toolCallId, new DeferredPromise())
    _fire(ActionType.ChatToolCallReady { toolCallId, confirmationTitle: 'shell' })
    await deferred.p
    ↓
VS Code chat UI shows approval card
User clicks "Allow"
    ↓
ChatToolCallConfirmed action
    → CopilotAgent.respondToPermissionRequest(toolCallId, true)
    → deferred.resolve(true)
    → { kind: 'approve-once' } returned to SDK
    ↓
CLI subprocess executes: npm install
```

---

## 8. Comparison: Copilot CLI vs Codex vs Claude

| Dimension | Copilot CLI (`agent-host-copilotcli`) | Claude (`agent-host-claude`) | Codex (`agent-host-openai-codex`) |
|---|---|---|---|
| **Provider id** | `'copilotcli'` | `'claude'` | `'codex'` |
| **Session type** | `'agent-host-copilotcli'` | `'agent-host-claude'` | `'agent-host-openai-codex'` |
| **SDK package** | `@github/copilot` (npm) | `@anthropic-ai/claude-agent-sdk` (npm) | `@openai/codex` (npm) |
| **SDK execution** | **Spawned subprocess** (stdio JSON-RPC) | **In-process** (loaded in agent-host) | **Spawned subprocess** (stdio JSON-RPC app-server) |
| **CLI entry point** | `@github/copilot/index.js` | N/A (in-process) | Codex app-server binary |
| **IPC protocol** | stdio JSON-RPC (named events) | In-process function calls | stdio JSON-RPC (bidirectional) |
| **Default enabled** | ✅ Unconditional | ✅ `true` | ❌ `false` |
| **SDK availability gate** | ❌ None (part of node_modules) | `product.agentSdks.claude` or devDependency | `product.agentSdks.codex` or env override |
| **Auth** | **Direct** GitHub token to SDK | **Nonce proxy** → CAPI | **Nonce proxy** → CAPI |
| **Proxy** | ❌ None | `ClaudeProxyService` (127.0.0.1) | `CodexProxyService` (127.0.0.1) |
| **Model source** | `client.listModels()` (SDK → CAPI) | `copilotApiService.models()` (Anthropic filter) | `copilotApiService.models()` (OpenAI/responses filter) |
| **Model variety** | All CAPI models | Anthropic-only | OpenAI-family only |
| **Approval mechanism** | `onPermissionRequest` callback → deferred map | `canUseTool` callback → deferred map | JSON-RPC `requestApproval` → deferred map |
| **Approval path** | `_handlePermissionRequest()` (5-tier) | `canUseTool` dispatch + `pending_confirmation` | `_handleCommandApprovalRequestRpc()` |
| **"Set permission" picker** | ✅ Affects via `_resolveSdkMode()` ('autopilot' → SDK mode) | ✅ Affects via `_handleToolReady()` + permission manager | ❌ Does NOT affect native tool calls |
| **Permission mode values** | SDK modes: `'plan' | 'interactive' | 'autopilot'` | `ClaudePermissionMode` (6 values) | `CodexApprovalPolicy` (4 values) |
| **Worktree isolation** | ✅ Optional Git worktree per session | ❌ | ❌ |
| **Plan mode** | ✅ `'plan'` (propose steps, no execute) | ✅ via `permissionMode` | ❌ |
| **Session persistence** | SDK internal store + `sessionDatabase` | SDK store + `claudeSessionMetadataStore` | `codexSessionMetadataStore` (threadId) |
| **Streaming events** | Named SDK events (`assistant.message_delta`, etc.) | Anthropic SSE (`content_block_delta`, etc.) | App-server JSON-RPC notifications (`item/agentMessage/delta`, etc.) |
| **Streaming mapper** | `mapSessionEvents.ts` | `claudeSdkMessageRouter.ts` | `codexMapAppServerEvents.ts` |

---

## 9. Key Design Insights

### Direct token vs nonce proxy

Copilot CLI is unique in passing the GitHub Copilot token **directly** to the subprocess. This is safe because:
1. The subprocess is a first-party Microsoft process (`@github/copilot`)
2. The token only works for Copilot API calls — not a general-purpose bearer token
3. The subprocess runs as the same OS user

Claude and Codex use a nonce proxy because their subprocesses (Anthropic SDK, OpenAI Codex app-server) use the token as an **Anthropic/OpenAI API key** — the proxy translates it to a CAPI call instead of allowing direct external API access.

### SDK mode vs permission mode

Copilot CLI's approval model is different from Claude and Codex:
- **Copilot CLI**: Mode is set **at the SDK level** (`'plan'/'interactive'/'autopilot'`). The SDK subprocess never sends `onPermissionRequest` in `'autopilot'` mode.
- **Claude**: Mode is set via `permissionMode` in SDK `Options`. In `'always-allow'`, the SDK never calls `canUseTool`.
- **Codex**: No SDK-level mode. Approval requests always come from the app-server based on `CodexApprovalPolicy`. The VS Code permission picker has no effect on Codex native tool calls.

### Unconditional registration reflects architectural maturity

CopilotAgent being unconditionally registered (no gate) reflects that it's the "default" background agent — the foundation on which the others are built. Claude (enabled by default) and Codex (disabled by default) were added later with explicit capability gates.

### Model sourcing via subprocess

Copilot CLI routes model listing through the CLI subprocess (`client.listModels()`), while Claude and Codex query CAPI directly. This means:
- Copilot CLI models reflect what the subprocess SDK exposes
- Claude/Codex models reflect VS Code's direct CAPI query (with vendor-specific filtering)
- Copilot CLI can expose **all CAPI model families** (GPT, Claude, Gemini), not just one vendor

---

## Appendix A — Key Source Files

### VS Code Core — Agent-Host Copilot CLI

| File | Purpose |
|---|---|
| `src/vs/platform/agentHost/node/copilot/copilotAgent.ts` | Main agent class (`CopilotAgent`), provider id `'copilotcli'`, session creation/materialization/sendMessage/respondToPermissionRequest |
| `src/vs/platform/agentHost/node/copilot/copilotAgentSession.ts` | Per-session state, `send()`, `_handlePermissionRequest()`, `_pendingPermissions` map |
| `src/vs/platform/agentHost/node/copilot/copilotSessionWrapper.ts` | Wraps `CopilotSession` events as VS Code `Event<T>` |
| `src/vs/platform/agentHost/node/copilot/copilotSessionLauncher.ts` | Session launch helpers |
| `src/vs/platform/agentHost/node/copilot/mapSessionEvents.ts` | Maps SDK session events to VS Code protocol turns |
| `src/vs/platform/agentHost/node/copilot/copilotTokenFields.ts` | `parseCopilotTokenFields()`, `isRestrictedTelemetryEnabled()` |
| `src/vs/platform/agentHost/node/copilot/copilotToolDisplay.ts` | Tool display metadata, `ITypedPermissionRequest` types |
| `src/vs/platform/agentHost/node/copilot/copilotShellTools.ts` | Shell tool name identification (`isShellTool()`) |
| `src/vs/platform/agentHost/node/copilot/agentHostSandboxEngine.ts` | Sandbox engine (MXC) for restricted shell execution |
| `src/vs/platform/agentHost/node/copilot/sandboxConfigForSdk.ts` | Sandbox config construction for SDK |
| `src/vs/platform/agentHost/node/copilot/pendingEditContentStore.ts` | In-progress file edit state |

### VS Code Core — Session Type Registry

| File | Purpose |
|---|---|
| `src/vs/workbench/contrib/chat/common/chatSessionsService.ts:306` | `SessionType.AgentHostCopilot = 'agent-host-copilotcli'` constant |
| `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostChatContribution.ts` | Derives session type from provider id, registers `registerDynamicAgent` |
| `src/vs/platform/agentHost/node/agentHostMain.ts` | Unconditional `CopilotAgent` registration |

### Extension Contribution

| File | Purpose |
|---|---|
| `extensions/copilot/package.json` ~line 6770 | `chatSessions` contribution: `type='copilotcli'`, `canDelegate: true`, capabilities |
