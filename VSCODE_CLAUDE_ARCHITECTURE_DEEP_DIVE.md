# VS Code Claude Code — Architecture Deep Dive

**Date**: 2026-06-19  
**Status**: Research complete  
**Scope**: VS Code agent-host and extension-side Claude Code integration, call chains, authentication, model sourcing, approval handling, and comparison to Codex.

---

## Table of Contents

1. [Overview — Two Claude Paths](#1-overview--two-claude-paths)
2. [The `chatSessions` Extension Point](#2-the-chatsessions-extension-point--the-gating-mechanism)
3. [Path A: Extension-Side `claude-code` (requires `github.copilot-chat`)](#3-path-a-extension-side-claude-code)
4. [Path B: Agent-Host Claude (`agent-host-claude`)](#4-path-b-agent-host-claude)
5. [Authentication — How Claude Gets Its Token](#5-authentication--how-claude-gets-its-token)
6. [Model Sourcing — CAPI Only](#6-model-sourcing--capi-only)
7. [Call Chain: Agent-Host Claude End-to-End](#7-call-chain-agent-host-claude-end-to-end)
8. [Comparison: Claude vs Codex](#8-comparison-claude-vs-codex)
9. [Key Design Insights](#9-key-design-insights)

---

## 1. Overview — Two Claude Paths

VS Code has **two paths** for Claude Code integration, analogous to Codex's two paths:

- **Path A** (`claude-code` extension session type): The `github.copilot-chat` extension contributes `chatSessions[type='claude-code', canDelegate: true]`. When `preferAgentHost` is **false**, requests route through the extension's own Claude Code integration (calling Anthropic-format APIs via the extension host). This is shown by the `when` condition: `!config.chat.agents.claude.preferAgentHost`.

- **Path B** (agent-host): `agent-host-claude` session type, registered dynamically by `agentHostChatContribution.ts` when the agent-host process reports a `claude` provider. Uses `@anthropic-ai/claude-agent-sdk` **loaded in-process** (not spawned). Talks to CAPI via a localhost nonce-proxy.

| | Path A: `claude-code` (extension) | Path B: `agent-host-claude` |
|---|---|---|
| **Session type ID** | `'claude-code'` | `'agent-host-claude'` |
| **Requires external extension** | ✅ `github.copilot-chat` | ❌ No — built into VS Code agent-host |
| **`canDelegate`** | `true` — routes through VS Code chat agent service | `true` — registered via `registerDynamicAgent` |
| **Shown when** | `!config.chat.agents.claude.preferAgentHost` | `config.chat.agents.claude.preferAgentHost` |
| **SDK** | Extension-managed (Anthropic format via CAPI) | `@anthropic-ai/claude-agent-sdk` (in-process) |
| **Auth** | Copilot token via extension | Nonce proxy → CAPI (same proxy pattern as Codex) |
| **Default gate** | `config.github.copilot.chat.claudeAgent.enabled=true` | Same setting + SDK available |
| **Models** | CAPI (Anthropic-vendor models) | CAPI (Anthropic-vendor models, filtered) |

### Key distinction from Codex

Unlike Codex (which uses an **app-server process** over JSON-RPC), Claude in agent-host loads `@anthropic-ai/claude-agent-sdk` **directly into the agent-host process**. The SDK is a devDependency of the VS Code repo, so no separate download is needed in dev builds.

---

## 2. The `chatSessions` Extension Point — The Gating Mechanism

### Registration

**File**: `extensions/copilot/package.json`, lines ~6717+

```json
{
  "type": "claude-code",
  "name": "claude",
  "displayName": "Claude",
  "icon": "$(claude)",
  "welcomeTitle": "Claude Agent",
  "welcomeMessage": "Powered by the same agent as Claude Code",
  "inputPlaceholder": "Run local tasks with Claude, type `#` for adding context",
  "order": 3,
  "description": "%github.copilot.session.providerDescription.claude%",
  "when": "config.github.copilot.chat.claudeAgent.enabled && ((isSessionsWindow && !config.chat.agents.claude.preferAgentHost) || (!isSessionsWindow && !config.chat.editor.claude.preferAgentHost))",
  "canDelegate": true,
  "requiresCustomModels": true,
  "supportsAutoModel": false
}
```

### What `canDelegate: true` means for Claude

Same mechanism as Codex Path B (Mode B):
1. `_enableContribution()` in `agentHostChatContribution.ts` checks `contribution.canDelegate`
2. If `true`: calls `_registerAgent()` → `chatAgentService.registerDynamicAgent()`
3. Creates `AgentHostSessionHandler` that delegates `invoke()` calls to the agent-host process
4. Creates `AgentHostLanguageModelProvider` for the in-session model picker

### Agent-host session type derivation

**File**: `src/vs/workbench/contrib/chat/common/chatSessionsService.ts:306–308`

```typescript
export namespace SessionType {
    export const AgentHostCopilot = 'agent-host-copilotcli';
    export const AgentHostClaude  = 'agent-host-claude';
    export const AgentHostCodex   = 'agent-host-codex';
}
```

**File**: `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostChatContribution.ts:35`

```typescript
const LOCAL_AGENT_HOST_SESSION_TYPE_PREFIX = 'agent-host-';
// ...
function getLocalAgentHostProviderForSessionType(sessionType: string): AgentProvider | undefined {
    if (!isLocalAgentHostTarget(sessionType) || !sessionType.startsWith(LOCAL_AGENT_HOST_SESSION_TYPE_PREFIX)) {
        return undefined;
    }
    return sessionType.slice(LOCAL_AGENT_HOST_SESSION_TYPE_PREFIX.length) || undefined;
    //     ↑ 'agent-host-claude'.slice(11) = 'claude'  ← the provider id
}
```

So `'agent-host-claude'` → provider `'claude'` → `ClaudeAgent.id === 'claude'`.

---

## 3. Path A: Extension-Side `claude-code`

When `preferAgentHost` is **false**, the `claude-code` session type is contributed with `canDelegate: true`. This routes through the copilot extension's own Claude implementation.

- The extension handles authentication via its own Claude Code login flow (separate from the agent-host nonce proxy)
- The extension talks to Anthropic APIs in a Copilot-compatible format  
- Session state is managed by the extension host process

**This path is not the focus of this document.** The deep-dive below covers Path B (agent-host).

---

## 4. Path B: Agent-Host Claude (`agent-host-claude`)

### 4.1 Startup gate (agent-host process)

**File**: `src/vs/platform/agentHost/node/agentHostMain.ts` (lines ~195–210)

```typescript
// agentHostMain.ts
agentService.registerProvider(instantiationService.createInstance(CopilotAgent));  // always registered

// Claude and Codex providers are gated on two things:
//  1. The user-facing enable toggle (Claude defaults to ON, Codex defaults to OFF)
//  2. The SDK being reachable
if (isAgentEnabled(process.env[AgentHostClaudeAgentEnabledEnvVar], true) &&
    (!environmentService.isBuilt || agentSdkDownloader.isAvailable(ClaudeSdkPackage))) {
    agentService.registerProvider(instantiationService.createInstance(ClaudeAgent));
}
```

**Three-condition gate:**

| Gate | Check | Default |
|---|---|---|
| **User enable toggle** | `isAgentEnabled(env[AgentHostClaudeAgentEnabledEnvVar], true)` | **true** (Claude is on by default) |
| **Dev build SDK** | `!environmentService.isBuilt` → SDK is devDependency, always available | ✅ passes in dev |
| **Production SDK** | `agentSdkDownloader.isAvailable(ClaudeSdkPackage)` | Needs `product.agentSdks.claude` or `VSCODE_AGENT_HOST_CLAUDE_SDK_ROOT` env override |

**`ClaudeSdkPackage` descriptor** — `src/vs/platform/agentHost/node/claude/claudeAgentSdkService.ts:23`:

```typescript
export const ClaudeSdkPackage: IAgentSdkPackage = {
    id: 'claude',
    devOverrideEnvVar: AgentHostClaudeSdkRootEnvVar,  // 'VSCODE_AGENT_HOST_CLAUDE_SDK_ROOT'
    hasSeparateMuslLinuxPackage: true,  // ships separate glibc + musl builds on Linux
};
```

**Key difference from Codex**: Claude defaults `enabled=true` (Codex defaults to `false`). Claude's SDK is a devDependency (`@anthropic-ai/claude-agent-sdk`) so it always works in dev builds without any extra setup.

### 4.2 Workbench registration chain

When agent-host reports `{ provider: 'claude', ... }` in its root state, `agentHostChatContribution.ts` fires:

```
ClaudeAgent registered in agent-host process
    ↓
agentHostChatContribution._onDidChangeRootState fires
    ↓
_shouldRegisterAgent('claude') → checks config.chat.agents.claude.preferAgentHost
    ↓
_registerAgent('claude'):
    sessionType = 'agent-host-claude'
    ↓
    chatSessionsService.registerChatSessionContribution({ type: 'agent-host-claude', canDelegate: true })
    ↓
    agentData = { id: 'agent-host-claude', ... }
    chatAgentService.registerDynamicAgent(agentData, { invoke: _invokeAgent })
    ↓
    AgentHostLanguageModelProvider created for 'agent-host-claude'
    languageModelsService.registerLanguageModelProvider('claude', provider)
    ↓
    Session type appears in the chat session picker
```

**`AgentHostLanguageModelProvider`** — same pattern as Codex:
- Sets `targetChatSessionType: 'agent-host-claude'` → models hidden from general picker
- Only shown in-session model dropdown
- `sendChatRequest()` throws — routing only, never makes API calls directly

### 4.3 Session type selection → session creation

When the user selects the `agent-host-claude` session type:

```
User selects 'agent-host-claude' in session picker
    ↓
chatAgentService.invokeAgent('agent-host-claude', request, ...)
    ↓
AgentHostSessionHandler._invokeAgent(request, progress, history, token)
    ↓
IPC → agentHostService.dispatch(sessionUri, { type: ChatTurnStarted, ... })
    ↓
agentSideEffects.handleAction(ChatTurnStarted, ...)
    ↓
agent.sendMessage(URI.parse(channel), message.text, attachments, turnId)
    → ClaudeAgent.sendMessage()
```

**Session URI format**: `agent://claude/<sessionId>`

### 4.4 First message: history hydration via `provideChatSessionContent`

Same pattern as Codex. `IChatSessionContentProvider.provideChatSessionContent(sessionUri, token)`:

- Reads persisted session metadata from `ClaudeSessionMetadataStore` (session ID, model, etc.)
- Calls `IClaudeAgentSdkService.getSessionMessages(sessionId)` to fetch past turns from the SDK's local store
- Maps SDK messages to VS Code chat turn history via `claudeReplayMapper.ts`
- Returns `ICodexSessionContent` (rehydrated history)

### 4.5 Request dispatch: `chatAgentService.invokeAgent`

Same as Codex — the standard workbench dispatch pipeline routes through `AgentHostSessionHandler._invokeAgent` which sends a `ChatTurnStarted` action over IPC to the agent-host process.

### 4.6 Agent-host process: `ClaudeAgent` → Anthropic SDK → Proxy → CAPI

**File**: `src/vs/platform/agentHost/node/claude/claudeAgent.ts`  
**Class**: `ClaudeAgent extends Disposable implements IAgent`  
**Provider id**: `ClaudeAgent.id = 'claude'` (line 147)

---

#### Step 0 — `ClaudeAgent._refreshModels(token)` — CAPI only, no SDK

```typescript
// claudeAgent.ts
private async _refreshModels(): Promise<void> {
    const all = await this._copilotApiService.models(
        this._githubToken,
        { headers: { 'User-Agent': userAgent }, suppressIntegrationId: true }
    );
    const filtered = all
        .filter(isClaudeModel)        // Anthropic vendor + /v1/messages support
        .sort((a, b) => Number(b.is_chat_default) - Number(a.is_chat_default))
        .map(m => toAgentModelInfo(m, this.id));
    this._models.set(filtered, undefined);
}

function isClaudeModel(m: CCAModel): boolean {
    return (
        m.vendor === 'Anthropic' &&
        !!m.supported_endpoints?.includes('/v1/messages') &&
        !!m.model_picker_enabled &&
        !!m.capabilities?.supports?.tool_calls &&
        tryParseClaudeModelId(m.id) !== undefined  // excludes synthetic IDs like 'auto'
    );
}
```

Filtering criteria: `vendor='Anthropic'` + `/v1/messages` endpoint + picker enabled + tool_calls support + parseable Claude model ID.

---

#### Step 1 — `ClaudeAgent.createSession(config)` → provisional, no SDK contact

```typescript
// claudeAgent.ts
async createSession(config: IAgentCreateSessionConfig): Promise<IAgentCreateSessionResult> {
    this._ensureAuthenticated();   // throws AHP_AUTH_REQUIRED if no proxy handle
    
    const sessionId = config.session ? AgentSession.id(config.session) : generateUuid();
    const sessionUri = AgentSession.uri(this.id, sessionId);
    
    // Re-use existing provisional if present
    const existing = this._findAnySession(sessionId);
    if (existing) { return { session: sessionUri, provisional: true, ... }; }
    
    const permissionMode = this._resolvePermissionMode(config.config);
    
    const session = ClaudeAgentSession.createProvisional(
        sessionId, sessionUri, config.workingDirectory, project,
        config.model, config.agent, config.config,
        new PendingRequestRegistry<CallToolResult>(),
        permissionMode, this._metadataStore, this._instantiationService
    );
    
    this._sessions.set(sessionId, entry);
    return { session: sessionUri, provisional: true, workingDirectory: ... };
}
```

Returns immediately. No SDK calls. The `ClaudeAgentSession` is in a *provisional* state — it stores the model/config selections but has no active SDK query.

---

#### Step 2 — `ClaudeProxyService.start(githubToken)` → ephemeral localhost proxy

**File**: `src/vs/platform/agentHost/node/claude/claudeProxyService.ts`

Same nonce proxy pattern as Codex, but adapted for Anthropic's API format:

```
authenticate(githubToken)
    ↓
ClaudeProxyService._startServer()
    → binds to 127.0.0.1:<random-port>
    → generates 256-bit nonce via Web Crypto
    → handle = { baseUrl: 'http://127.0.0.1:<port>', nonce }
    ↓
_proxyHandle = handle
```

The proxy accepts Anthropic-format requests (`POST /v1/messages`) authenticated with the nonce, and forwards them to CAPI with the GitHub token attached.

**Auth flow** (`claudeProxyAuth.ts`):

```typescript
// claudeProxyAuth.ts
export function parseProxyBearer(headers: IncomingHttpHeaders, expectedNonce: string) {
    const bearer = headers['authorization']?.replace(/^Bearer\s+/, '') ?? '';
    const [nonce, sessionId] = bearer.split('.');
    if (!timingSafeEqual(Buffer.from(nonce), Buffer.from(expectedNonce))) {
        return { valid: false };
    }
    return { valid: true, sessionId };
}
```

- Nonce is **256-bit** hex (cryptographically strong)
- Validated with `timingSafeEqual` to prevent timing attacks
- Session ID suffix ensures **cross-session isolation**

---

#### Step 3 — `ClaudeAgentSession.materialize()` → SDK startup

**Called lazily**: on first `sendMessage()` call via `_sessionSequencer`.

```typescript
// claudeAgentSession.ts — materialize()
async materialize(ctx: IMaterializeContext): Promise<void> {
    // Stage 1: Build SDK options
    const options = buildSdkOptions({
        model: this._provisionalModel,
        permissionMode: this._permissionModeFallback,
        project: this.project,
        tools: dynamicTools,
        mcpServers: this._mcpServers,
        ANTHROPIC_BASE_URL: ctx.proxyHandle.baseUrl,
        ANTHROPIC_AUTH_TOKEN: `${ctx.proxyHandle.nonce}.${this.sessionId}`,
    });
    
    // Stage 2: Start the SDK (in-process, not spawned)
    const warm = await this._sdkService.startup({ options, initializeTimeoutMs: 30_000 });
    //           ↑ IClaudeAgentSdkService.startup() → @anthropic-ai/claude-agent-sdk
    
    // Stage 3: Build the pipeline
    this._pipeline = new ClaudeSdkPipeline(
        this.sessionId, this.sessionUri, warm, this.abortController, ...
    );
    
    // Stage 4: Write metadata
    await this._metadataStore.write(sessionUri, {
        model: this._provisionalModel,
        permissionMode: this._permissionModeFallback,
    });
}
```

**`IClaudeAgentSdkService.startup()` — in-process SDK call**:

```typescript
// claudeAgentSdkService.ts
async startup(params: { options: Options; initializeTimeoutMs?: number }): Promise<WarmQuery> {
    const sdk = await this._loadSdk();  // lazy require('@anthropic-ai/claude-agent-sdk')
    return sdk.startup(params.options, { initializeTimeoutMs: params.initializeTimeoutMs });
}
```

`sdk.startup()` returns a `WarmQuery` — a pre-warmed SDK session object ready to accept queries. **This runs inside the agent-host process** (unlike Codex which spawns an external app-server).

---

#### Step 4 — `ClaudeAgent.sendMessage()` → SDK query → Anthropic Messages API

```typescript
// claudeAgent.ts
async sendMessage(sessionUri: URI, request: IChatRequest): Promise<void> {
    const sessionId = AgentSession.id(sessionUri);
    
    await this._sessionSequencer.queue(sessionId, async () => {
        let session = this._findAnySession(sessionId);
        
        // Promote provisional → live if needed
        if (!session?.isPipelineReady) {
            session = await this._materializeProvisional(sessionId);
        }
        
        // Live permission mode re-read on every send
        session.setPermissionMode(this._readSessionPermissionMode(session.sessionUri));
        
        // Send via pipeline
        await session.send(request, this._onDidSessionProgress.fire.bind(...));
    });
}

// claudeAgentSession.ts
async send(request: IChatRequest): Promise<void> {
    const query = await this._pipeline.warm.query({
        prompt: request.text,
        attachments: resolvedAttachments,
    });
    // query is an AsyncIterable<SDKMessage> — streamed response
    for await (const message of query) {
        await this._router.routeMessage(message);  // claudeSdkMessageRouter.ts
    }
}
```

**Wire format**: The SDK constructs a request to the proxy:
```
POST http://127.0.0.1:<port>/v1/messages
Authorization: Bearer <256-bit-nonce>.<sessionId>
Content-Type: application/json

{
  "model": "claude-sonnet-4-5",
  "messages": [...],
  "tools": [...],
  "stream": true
}
```

The proxy validates the nonce, translates to CAPI format, and forwards.

---

#### Step 5 — Streaming: SDK events → VS Code Chat UI

**Three-layer transformation** (analogous to Codex's notification → mapper chain):

**Layer 1 — SDK stream events (Anthropic SSE format)**:

```
event: message_start       → mapMessageStart()
event: content_block_start → mapContentBlockStart()  [text | tool_use | thinking]
event: content_block_delta → mapContentBlockDelta()  [text_delta | input_json_delta]
event: content_block_stop  → mapContentBlockStop()
event: message_delta       → mapMessageDelta()       [stop_reason, usage]
event: message_stop        → { kind: 'ChatTurnComplete' }
```

**Layer 2 — `claudeSdkMessageRouter.ts` → `AgentSignal[]`**:

```typescript
// claudeSdkMessageRouter.ts
export async function routeMessage(
    message: SDKMessage,
    state: ClaudeMapperState,
    ...
): Promise<AgentSignal[]> {
    switch (message.type) {
        case 'message_start':
            return mapMessageStart(message.message);
        case 'content_block_start':
            return mapContentBlockStart(message, state);
        case 'content_block_delta':
            return mapContentBlockDelta(message, state);
        case 'content_block_stop':
            return mapContentBlockStop(message, state);
        case 'message_delta':
            return mapMessageDelta(message, state);
        case 'message_stop':
            return [{ kind: 'ChatTurnComplete', ... }];
    }
}
```

**Layer 3 — `AgentSignal[]` → VS Code protocol actions → Chat UI**:

| SDK `content_block_start type` | Mapper | VS Code action | UI effect |
|---|---|---|---|
| `'text'` | `mapContentBlockStart` | `ChatMarkdownChunk` (delta) | Streamed text in response |
| `'thinking'` | `mapContentBlockStart` | `ChatMarkdownChunk` with thinking flag | Thinking bubble |
| `'tool_use'` | `mapContentBlockStart` | `ChatToolCallStart` | Tool call badge opens |
| text `content_block_delta` | `mapContentBlockDelta` | `ChatMarkdownChunk` | Incremental text |
| `input_json_delta` | `mapContentBlockDelta` | `ChatToolCallInputChunk` | Tool input streams |
| `content_block_stop` (tool_use) | `mapContentBlockStop` | `ChatToolCallReady` / `pending_confirmation` | Approval card (if needed) |
| `message_delta` stop_reason | `mapMessageDelta` | `ChatTokenUsageUpdate` | Token usage display |
| `message_stop` | — | `ChatTurnComplete` | Finalizes turn |

**Comparison with traditional chat participants**:

| Dimension | Claude (agent-host) | Traditional `@copilot` |
|---|---|---|
| **Event source** | Anthropic SSE (`/v1/messages` response) | OpenAI SSE (via Copilot token) |
| **Response streaming** | SDK `content_block_delta` events | VS Code LM API `createLanguageModelChatResponse` stream |
| **Tool execution** | `canUseTool` callback + `pending_confirmation` | VS Code LM tool-calling API |
| **Session persistence** | `@anthropic-ai/claude-agent-sdk` internal store | No persistent session |
| **Process boundary** | In-process SDK (agent-host process) | Extension host process |

---

#### Step 6 — Proxy → CAPI forwarding

When the proxy receives a request from the in-process SDK:

```
SDK sends POST /v1/messages to localhost proxy
    ↓
ClaudeProxy validates nonce (timingSafeEqual)
    ↓
Strips proxy-specific headers
    ↓
Adds Authorization: Bearer <github-token>
    ↓
Rewrites URL: http://127.0.0.1:<port>/v1/messages → CAPI /v1/messages endpoint
    ↓
Forwards to CAPI
    ↓
CAPI sends to Anthropic claude-* model
    ↓
SSE response streams back through proxy → SDK → router → VS Code chat UI
```

---

### 4.7 Approval handling

Claude's approval system uses the **`permissionMode`** concept with a `canUseTool` SDK callback. This is fundamentally different from Codex (which uses JSON-RPC `requestApproval` callbacks from a separate process).

---

#### System 1 — Claude permission mode (`ClaudePermissionMode`)

**File**: `src/vs/platform/agentHost/node/claude/claudeSessionPermissionMode.ts`

```typescript
// Six host-side values
export type ClaudePermissionMode =
    | 'default'        // SDK decides per-tool; 'canUseTool' for interactive tools
    | 'always-ask'     // Prompt on every tool call
    | 'always-allow'   // Auto-approve all tools
    | 'never'          // Auto-deny all tools
    | 'accept-edits'   // Only approve file edit tools
    | 'dontAsk';       // UI alias for 'always-allow'

// Five values sent to SDK (dontAsk maps to 'always-allow')
export type PermissionMode = 'default' | 'always-ask' | 'always-allow' | 'never' | 'accept-edits';
```

**How it flows into the SDK**:

```typescript
// claudeAgentSession.ts — materialize()
const options: Options = {
    model: ...,
    permissionMode: this._permissionModeFallback,  // set at session creation
    // ...
};
const warm = await sdkService.startup({ options });

// claudeAgent.ts — sendMessage(), before every turn
session.setPermissionMode(this._readSessionPermissionMode(session.sessionUri));
// ↑ re-reads live config so UI changes take effect immediately
```

**Mapping from VS Code "Set permission" picker** (`SessionConfigKey.AutoApprove`) to Claude permission mode:

| VS Code picker | `SessionConfigKey.AutoApprove` | Claude `permissionMode` sent to SDK |
|---|---|---|
| Default Approvals | `'default'` | `'default'` |
| Bypass Approvals | `'autoApprove'` | `'always-allow'` |
| Autopilot | `'autopilot'` | `'always-allow'` |

The mapping is done by `_readSessionPermissionMode()` which reads both `SessionConfigKey.AutoApprove` and the Claude-specific session config keys.

---

#### System 2 — `canUseTool` callback (SDK-level gate)

**File**: `src/vs/platform/agentHost/node/claude/claudeCanUseTool.ts`

When `permissionMode='default'`, the SDK invokes `canUseTool` for tools it decides need host approval. The callback:

```typescript
// claudeCanUseTool.ts
async function handleCanUseTool(
    deps: IClaudeCanUseToolDeps,
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: IClaudeCanUseToolOptions,
): Promise<PermissionResult> {
    const session = deps.getSession(sessionId);
    if (!session) return { behavior: 'deny', message: 'Session is no longer active' };
    
    return await dispatchCanUseTool(deps, session, toolName, input, options);
}
```

**Tool categories** (from `claudeInteractiveTools.ts`):

| Category | Examples | Default behavior |
|---|---|---|
| **Interactive** | `'bash'`, `'file_edit'`, `'web_search'` | Triggers `canUseTool` → host approval |
| **Subagent tools** | `'invoke_subagent'` | Routes to subagent registry |
| **MCP tools** | `'mcp_*'` | Pass-through (auto-approved by default) |
| **Client tools** | Custom tools from VS Code | Routed to client-tool MCP server |

---

#### Approval propagation flow

When `canUseTool` requires host approval:

```
SDK calls canUseTool(toolName, input)
    ↓
claudeCanUseTool.dispatchCanUseTool()
    ↓
session.requestPermission(toolUseId)
    → registers deferred in _pendingPermissions Map<toolUseId, DeferredPromise<boolean>>
    ↓
Fires ActionType.ChatToolCallReady {
    type: 'pending_confirmation',
    toolCallId: toolUseId,
    confirmationTitle: toolName,
    toolInput: JSON.stringify(input),
}
    ↓
agentSideEffects._handleToolReady(event)
    → SessionPermissionManager.getAutoApproval()
        ← checks SessionConfigKey.AutoApprove (VS Code "Set permission" picker)
    ↓
If auto-approved (autoApprove/autopilot):
    → agent.respondToPermissionRequest(toolUseId, true) immediately
    → deferred.resolve(true)
    → SDK proceeds

If not auto-approved:
    → VS Code chat UI shows approval card
    → User clicks Allow/Deny
    → ChatToolCallConfirmed action
    → agentSideEffects.handleAction(ChatToolCallConfirmed)
    → agent.respondToPermissionRequest(toolUseId, approved)
    → claudeAgentSession.respondToPermissionRequest(toolUseId, approved)
    → deferred.resolve(approved)
    → canUseTool returns { behavior: 'allow' | 'deny' }
    → SDK proceeds or skips the tool
```

**Key difference from Codex**: The VS Code `SessionConfigKey.AutoApprove` (the "Set permission" picker) **does affect Claude** because Claude uses the `pending_confirmation` path through `agentSideEffects._handleToolReady()`. This is unlike Codex, where native tool calls bypass that path.

---

### 4.8 Session persistence (across restarts)

**File**: `src/vs/platform/agentHost/node/claude/claudeSessionMetadataStore.ts`

Stores per-session metadata:
- `sessionId` → UUID
- `model` → last used model ID  
- `permissionMode` → last used permission mode

On restart, `provideChatSessionContent` reads history via `IClaudeAgentSdkService.getSessionMessages(sessionId)` — the SDK's internal store (usually `~/.claude/` or VS Code's appdata) holds conversation history.

---

## 5. Authentication — How Claude Gets Its Token

### The two-token nonce proxy pattern

Same architectural pattern as Codex, adapted for Anthropic's API format:

```
Step 1: GitHub Copilot token arrives via authenticate()
    claudeAgent.authenticate(resource, githubToken)
    ↓
Step 2: Proxy (re)starts with new token
    claudeProxyService.start(githubToken)
    → Binds to 127.0.0.1:<random-port>
    → Generates 256-bit nonce
    → Stores { baseUrl, nonce }
    ↓
Step 3: SDK options set proxy as Anthropic base URL
    ANTHROPIC_BASE_URL = 'http://127.0.0.1:<port>'
    ANTHROPIC_AUTH_TOKEN = '<256-bit-nonce>.<sessionId>'
    ↓
Step 4: SDK makes: POST http://127.0.0.1:<port>/v1/messages
    Authorization: Bearer <nonce>.<sessionId>
    ↓
Step 5: Proxy validates nonce (timingSafeEqual), extracts sessionId
Step 6: Proxy rewrites → CAPI /v1/messages
    Authorization: Bearer <github-token>  ← GitHub token used here
    ↓
Step 7: CAPI → Anthropic model → SSE stream back
```

**Security properties:**
- Nonce: **256-bit** hex, per proxy instance (not per session)
- Session ID suffix: prevents cross-session reuse
- `timingSafeEqual`: prevents timing oracle attacks
- Proxy binds to **127.0.0.1** (loopback only)
- GitHub token **never leaves** the VS Code agent-host process

**File references**:
- `claudeProxyService.ts` — proxy server lifecycle, nonce generation
- `claudeProxyAuth.ts` — `parseProxyBearer()`, `timingSafeEqual` validation

---

## 6. Model Sourcing — CAPI Only

**Unlike Codex** (which can pull models from OpenAI directly), Claude models come **exclusively from CAPI**.

**Filter chain** (`claudeAgent.ts`):

```
CAPI GET /models (all models)
    ↓
filter: vendor === 'Anthropic'
    ↓
filter: supported_endpoints includes '/v1/messages'
    ↓
filter: model_picker_enabled === true
    ↓
filter: capabilities.supports.tool_calls === true
    ↓
filter: tryParseClaudeModelId(m.id) !== undefined  (no synthetic 'auto' IDs)
    ↓
sort: is_chat_default DESC (default model first)
    ↓
map: toAgentModelInfo(m, 'claude')
    ↓
ClaudeAgent._models.set(filtered, undefined)
    ↓
AgentHostLanguageModelProvider reads models for in-session picker
```

Models are refreshed on every `authenticate()` call (when the GitHub token changes).

---

## 7. Call Chain: Agent-Host Claude End-to-End

### Initialization

```
VS Code starts → agentHostMain.ts
    ↓
isAgentEnabled(env.VSCODE_AGENT_HOST_CLAUDE_AGENT_ENABLED, default=true) → true
    ↓
agentSdkDownloader.isAvailable(ClaudeSdkPackage)
    → dev builds: always true (devDependency)
    → production: product.agentSdks.claude or VSCODE_AGENT_HOST_CLAUDE_SDK_ROOT
    ↓
agentService.registerProvider(ClaudeAgent instance)
    ↓
ClaudeAgent.authenticate(GITHUB_COPILOT_PROTECTED_RESOURCE, githubToken)
    ↓
claudeProxyService.start(githubToken)
    → bind 127.0.0.1:<random-port>
    → generate 256-bit nonce
    ↓
ClaudeAgent._refreshModels(githubToken) → CAPI /models → filter Anthropic models
    ↓
agentHostChatContribution detects 'claude' provider
    → registers 'agent-host-claude' session type (if preferAgentHost=true)
    → registers AgentHostLanguageModelProvider
    → registers dynamic agent via chatAgentService.registerDynamicAgent()
```

### First chat request

```
User opens 'agent-host-claude' session
    ↓
WorkbenchChatWidget → chatAgentService.invokeAgent('agent-host-claude', request)
    ↓
AgentHostSessionHandler._invokeAgent(request, progress, history, token)
    ↓
IPC → agentHostService.dispatch(sessionUri, { type: ActionType.ChatTurnStarted, ... })
    ↓
agentSideEffects.handleAction(ChatTurnStarted, ...)
    ↓
ClaudeAgent.sendMessage(sessionUri, text, attachments, turnId)
    ↓
_sessionSequencer.queue(sessionId, async () => {
    ↓
    // First message: provisional session → materialize
    claudeAgentSession.materialize({
        proxyHandle: { baseUrl, nonce }
    })
    ↓
    IClaudeAgentSdkService.startup({
        options: {
            model: 'claude-sonnet-4-5',
            permissionMode: 'default',
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:<port>',
            ANTHROPIC_AUTH_TOKEN: '<nonce>.<sessionId>',
            tools: [...],
            mcpServers: [...],
        }
    })
    → @anthropic-ai/claude-agent-sdk.startup() [in-process]
    → returns WarmQuery
    ↓
    session.send(request)
    ↓
    pipeline.warm.query({ prompt, attachments })
    → AsyncIterable<SDKMessage>
})
```

### Streaming events

```
SDK yields SDKMessage stream events:
    message_start
    content_block_start { type: 'text' }
    content_block_delta { type: 'text_delta', text: 'I will...' }
    content_block_stop
    content_block_start { type: 'tool_use', name: 'bash', id: 'tu_001' }
    content_block_delta { type: 'input_json_delta', partial_json: '{"command":' }
    content_block_stop   ← canUseTool('bash', {command: 'ls -la'}) called HERE
    message_delta { stop_reason: 'tool_use' }
    message_stop
    ↓
claudeSdkMessageRouter.routeMessage() → AgentSignal[]
    ↓
agentSideEffects._handleAgentSignal() → protocol actions
    ↓
VS Code chat UI updates
```

---

## 8. Comparison: Claude vs Codex

| Dimension | Claude (`agent-host-claude`) | Codex (`agent-host-openai-codex`) |
|---|---|---|
| **Provider id** | `'claude'` | `'codex'` |
| **Session type** | `'agent-host-claude'` | `'agent-host-openai-codex'` (or `'agent-host-codex'`) |
| **SDK type** | `@anthropic-ai/claude-agent-sdk` **loaded in-process** | `@openai/codex` **spawned as external app-server** |
| **Wire protocol** | HTTP SSE (`/v1/messages`) via localhost proxy | JSON-RPC over stdio to app-server process |
| **Process boundary** | SDK runs inside agent-host process | SDK runs in separate child process |
| **Default enabled** | ✅ `true` | ❌ `false` |
| **Dev SDK availability** | ✅ Always (devDependency) | ❌ Requires env override or `product.agentSdks.codex` |
| **Auth proxy** | Nonce proxy → CAPI (`/v1/messages` Anthropic format) | Nonce proxy → CAPI (`/responses` OpenAI format) |
| **Approval system** | `canUseTool` callback + `pending_confirmation` path | JSON-RPC `commandExecution/requestApproval` callback |
| **"Set permission" picker effect** | ✅ Directly affects approval (via `_handleToolReady` path) | ❌ Does NOT affect native tool calls (bypasses `_handleToolReady`) |
| **Permission mode** | 6-level `ClaudePermissionMode` (`default/always-ask/always-allow/never/accept-edits/dontAsk`) | 4-level `CodexApprovalPolicy` (`never/on-request/on-failure/untrusted`) |
| **Model source** | CAPI only (`vendor='Anthropic'`) | CAPI (OpenAI-family models with `/responses` support) |
| **Model filter** | `/v1/messages` endpoint + tool_calls support | `/responses` endpoint support |
| **Session persistence** | `@anthropic-ai/claude-agent-sdk` internal store + metadata overlay | `CodexSessionMetadataStore` (threadId, lastTurnId, model) |
| **History hydration** | `getSessionMessages(sessionId)` via SDK | `thread/read` RPC to app-server |
| **Thinking/reasoning** | `content_block_start { type: 'thinking' }` → thinking bubble | `item/reasoning/summaryTextDelta` → thinking bubble |
| **MCP support** | ✅ Via `mcpServers` in SDK `Options` | ✅ Via Codex's built-in MCP server handling |
| **Extension also contributes** | `'claude-code'` (with `canDelegate: true`) | `'openai-codex'` (without `canDelegate`) |

---

## 9. Key Design Insights

### In-process SDK vs app-server

The most fundamental architectural difference from Codex:
- **Codex** spawns a child process (`@openai/codex`) and communicates via JSON-RPC. Approval requests arrive as JSON-RPC callbacks (`commandExecution/requestApproval`). VS Code has to maintain a deferred-promise registry.
- **Claude** loads `@anthropic-ai/claude-agent-sdk` directly into the agent-host process. The SDK calls `canUseTool()` synchronously in the same process. This is simpler (no IPC for approval), but means the SDK runs in the same heap/process space as the agent-host.

### "Set permission" picker has different effects

For Claude: the VS Code `SessionConfigKey.AutoApprove` (Default/Bypass/Autopilot) **works** via the standard `_handleToolReady()` → `SessionPermissionManager.getAutoApproval()` path.

For Codex: the same picker does NOT affect native shell/file approvals (they bypass `_handleToolReady()`). Only Codex's `CodexSessionConfigKey.ApprovalPolicy` matters for shell/file calls.

### Dual registration paths

Both Claude and Codex have a dual-path architecture:
1. Extension-contributed session type (via `chatSessions`) — `'claude-code'` / `'openai-codex'`
2. Agent-host-registered session type — `'agent-host-claude'` / `'agent-host-openai-codex'`

For Claude, the two paths are gated by `config.chat.agents.claude.preferAgentHost`. For Codex, Path A (extension) and Path B (agent-host) are independent.

---

## Appendix A — Key Source Files

### VS Code Core — Agent-Host Claude

| File | Purpose |
|---|---|
| `src/vs/platform/agentHost/node/claude/claudeAgent.ts` | Main agent class (`ClaudeAgent`), provider id `'claude'`, session creation/materialization/sendMessage |
| `src/vs/platform/agentHost/node/claude/claudeAgentSession.ts` | Per-session state, SDK pipeline, `send()`, `materialize()`, `respondToPermissionRequest()` |
| `src/vs/platform/agentHost/node/claude/claudeAgentSdkService.ts` | `IClaudeAgentSdkService` — lazy SDK loading, `startup()` shim, `ClaudeSdkPackage` descriptor |
| `src/vs/platform/agentHost/node/claude/claudeSdkPipeline.ts` | Wraps `WarmQuery`, drives the event loop (`for await message of query`) |
| `src/vs/platform/agentHost/node/claude/claudeSdkMessageRouter.ts` | Maps Anthropic SSE events to `AgentSignal[]` |
| `src/vs/platform/agentHost/node/claude/claudeMapSessionEvents.ts` | Higher-level event mapping for session history |
| `src/vs/platform/agentHost/node/claude/claudeCanUseTool.ts` | `canUseTool` callback dispatch, tool classification, permission decision |
| `src/vs/platform/agentHost/node/claude/claudeSessionPermissionMode.ts` | `ClaudePermissionMode` types, read/write helpers |
| `src/vs/platform/agentHost/node/claude/claudeProxyService.ts` | Localhost nonce proxy lifecycle (bind, nonce generation) |
| `src/vs/platform/agentHost/node/claude/claudeProxyAuth.ts` | `parseProxyBearer()`, `timingSafeEqual` validation |
| `src/vs/platform/agentHost/node/claude/claudeInteractiveTools.ts` | Tool classification (`INTERACTIVE_CLAUDE_TOOLS`) |
| `src/vs/platform/agentHost/node/claude/claudeSessionMetadataStore.ts` | Persistent session metadata (model, permissionMode) |
| `src/vs/platform/agentHost/node/claude/claudeReplayMapper.ts` | Maps SDK `SessionMessage[]` to VS Code chat history for hydration |

### VS Code Core — Session Type Registry

| File | Purpose |
|---|---|
| `src/vs/workbench/contrib/chat/common/chatSessionsService.ts:306–308` | `SessionType.AgentHostClaude = 'agent-host-claude'` constant |
| `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostChatContribution.ts` | Derives session type from provider id, registers `registerDynamicAgent` |
| `src/vs/platform/agentHost/node/agentHostMain.ts` | Agent-host startup gate for Claude |

### Extension Contribution

| File | Purpose |
|---|---|
| `extensions/copilot/package.json` ~line 6717 | `chatSessions` contribution: `type='claude-code'`, `canDelegate: true` |
