# VS Code Codex Delegation — Architecture Deep Dive

**Date**: 2026-06-19 (corrected — stable/insiders distinction revised with code evidence)  
**Status**: Research complete  
**Scope**: VS Code agent-host and extension-side Codex integration, call chains, authentication, model sourcing, and comparison to background-agent (CLI) delegation and the proposed LM provider adapter.

---

## Table of Contents

1. [Overview — Two Distinct Codex Paths](#1-overview--two-distinct-codex-paths)
2. [The `chatSessions` Extension Point — The Gating Mechanism](#2-the-chatsessions-extension-point--the-gating-mechanism)
3. [Path A: Extension-Side `openai-codex` (requires `openai.chatgpt` extension)](#3-path-a-extension-side-openai-codex)
4. [Path B: Agent-Host Codex (`agent-host-openai-codex`)](#4-path-b-agent-host-codex)
5. [Authentication — How Codex Gets Its Token](#5-authentication--how-codex-gets-its-token)
6. [Model Sourcing — CAPI or OpenAI Subscription?](#6-model-sourcing--capi-or-openai-subscription)
7. [Call Chain: Agent-Host Codex End-to-End](#7-call-chain-agent-host-codex-end-to-end)
8. [Comparison: Codex vs Background-Agent (CLI) Delegation](#8-comparison-codex-vs-background-agent-cli-delegation)
9. [Comparison: VS Code Codex vs Proposed LM Provider Adapter](#9-comparison-vs-code-codex-vs-proposed-lm-provider-adapter)
10. [Key Design Insights for the Proposal](#10-key-design-insights-for-the-proposal)

---

## 1. Overview — Two Distinct Codex Paths

VS Code has **two independent paths** for Codex integration. They are architecturally distinct in purpose:

- **Path A** (`openai.chatgpt` extension): A **standalone webview app** bundled as a VS Code extension. Its `chatSessions[type='openai-codex']` contribution (without `canDelegate`) is only for **reading session history**. It has **no integration with VS Code's chat dispatch pipeline** — all requests are handled inside the extension's own webview.

- **Path B** (agent-host): Entirely built into VS Code core. Registers a dynamic agent via `chatAgentService.registerDynamicAgent`, routes requests through the standard `chatAgentService.invokeAgent` pipeline, and uses a separate `provideChatSessionContent` for history reading only.

| | Path A: `openai.chatgpt` extension | Path B: Agent-host |
|---|---|---|
| **Session type ID** | `'openai-codex'` | `'agent-host-openai-codex'` |
| **Requires external extension** | ✅ Yes — `openai.chatgpt` | ❌ No — built into VS Code agent-host |
| **`canDelegate`** | Determines registration mode (see §3): absent → standalone webview mode; `true` → routes through VS Code chat | ✅ `true` — both data and impl registered |
| **Request routing** | ❌ None — standalone webview handles everything | ✅ `chatAgentService.invokeAgent('agent-host-openai-codex', ...)` → `_invokeAgent` |
| **`chatSessions` usage** | History reading only — `provideChatSessionContent` loads past turns | History reading only — `provideChatSessionContent` loads turns from agent-host process |
| **Available in** | Not in OSS `product.json` — distribution mechanism not visible in this repo | SDK must come from one of: (1) user sets `chat.agentHost.codexAgent.sdkRoot` to a local install, (2) `product.agentSdks.codex` in product config (absent from OSS), or (3) `VSCODE_AGENT_HOST_CODEX_SDK_ROOT` env override. Also requires `chat.agentHost.codexAgent.enabled=true` (default: `false`). |
| **Models come from** | Extension's own webview (OpenAI API) | Copilot API catalog, filtered for `/responses` support |
| **Auth** | Managed by `openai.chatgpt` extension (OpenAI API key / OAuth) | GitHub Copilot nonce proxy — CAPI forwarding |
| **Model source** | OpenAI directly | Copilot CAPI (via proxy nonce) |

### Agent-host availability gate — code evidence

The OSS `product.json` (this repo) only has one entry in `builtInExtensionsEnabledWithAutoUpdates`:

```json
// product.json (OSS — verified)
"builtInExtensionsEnabledWithAutoUpdates": [
    "GitHub.copilot-chat"
]
```

`openai.chatgpt` is absent. How or whether it is distributed in non-OSS builds is not visible from this repo.

For Path B, the gate is `agentSdkDownloader.isAvailable(CodexSdkPackage)` — verified from source:

```typescript
// src/vs/platform/agentHost/node/agentSdkDownloader.ts:185
isAvailable(pkg: IAgentSdkPackage): boolean {
    if (process.env[pkg.devOverrideEnvVar]) {
        return true;  // dev override (VSCODE_AGENT_HOST_CODEX_SDK_ROOT)
    }
    return !!this._productService.agentSdks?.[pkg.id] && resolveSdkTarget(pkg) !== undefined;
}
```

Since OSS `product.json` has no `agentSdks` key, `this._productService.agentSdks?.codex` is `undefined` and `isAvailable` returns `false`. The agent-host Codex path is **never registered** in any build using the OSS product.json.

---

## 2. The `chatSessions` Extension Point — The Gating Mechanism

### Registration

```typescript
// src/vs/workbench/contrib/chat/browser/chatSessions/chatSessions.contribution.ts:58
const extensionPoint = ExtensionsRegistry.registerExtensionPoint<IChatSessionsExtensionPoint[]>({
    extensionPoint: 'chatSessions',
    jsonSchema: { ... }
});
```

This is VS Code core's public extension point. Any extension that declares `"enabledApiProposals": ["chatSessionsProvider"]` in its `package.json` can contribute session types via `contributes.chatSessions`.

### What the Copilot extension contributes

The Copilot Chat extension (`extensions/copilot/package.json`, line 6710) declares exactly three session types:

| type | display name | purpose |
|---|---|---|
| `copilotcli` | Copilot CLI | Background agent (the well-documented path) |
| `claude-code` | Claude | Claude Code agent |
| `copilot-cloud-agent` | Cloud | GitHub-integrated cloud agent |

**`openai-codex` is absent from this list.** The constant `SessionType.Codex = 'openai-codex'` exists in VS Code core (`chatSessionsService.ts:304`) to name the type, but the contribution that makes it appear in the UI comes exclusively from the `openai.chatgpt` extension.

### How availability is determined

```typescript
// src/vs/workbench/contrib/chat/common/sessionTypeAvailability.ts
function getSessionTypeAvailability(chatSessionsService, ..., type) {
    if (supportsAutoModelForSessionType(type)) return Available;
    if (hasModelsTargetingSessionType(languageModelsService, type)) return Available;
    const contribution = chatSessionsService.getChatSessionContribution(type);
    if (!contribution) return Available;   // ← type not registered → silently not shown
    ...
}
```

Without a contribution registered by the `openai.chatgpt` extension:
- `getAllChatSessionContributions()` never includes `'openai-codex'`
- The session type simply never appears in the picker/delegation menu

### The proposed API gate

```typescript
// src/vs/workbench/api/browser/viewsExtensionPoint.ts:459
if (key === 'agentSessions' && !isProposedApiEnabled(extension.description, 'chatSessionsProvider')) {
    collector.warn(...)
}
```

Only extensions allowlisted for the `chatSessionsProvider` proposed API (currently `openai.chatgpt`, `github.copilot`) can contribute session types. This is a security boundary preventing arbitrary extensions from injecting session providers.

---

## 3. Path A: `openai.chatgpt` — the extension that contributes the Codex agent to the session picker

> **VS Code team confirmation:** VS Code contributor `mjbvz` stated: *"Unlike most of the other options in this view, the `Codex` agent option here is actually contributed by the codex extension"* ([microsoft/vscode#310624](https://github.com/microsoft/vscode/issues/310624#issuecomment-4626350718)). The extension's `chatSessions` contribution is what makes the Codex entry appear in the session type picker — VS Code core does not contribute it.

> **Note on the analyzed package.json:** The version read directly was `openai.chatgpt-26.5609.30741`. Versions reported broken in the bug tracker were `26.519.32039` and later. The registration behavior (especially `canDelegate`) may differ across versions. Treat the JSON below as reflecting the analyzed version, not necessarily the current release.

### What the extension actually contributes

The `openai.chatgpt` extension is a **standalone webview application** bundled as a VS Code extension. It has its own sidebar and custom editor — it does **not** integrate with VS Code's chat agent dispatch at all.

Actual `contributes` keys: `commands`, `keybindings`, `configuration`, `viewsContainers`, `views`, `customEditors`, `menus`, `chatSessions`, `grammars`, `languages`.

Notably absent: `chatParticipants`.

```json
// Actual openai.chatgpt package.json (verified for version 26.5609.30741)
{
  "enabledApiProposals": ["chatSessionsProvider", "languageModelProxy"],
  "contributes": {
    "chatSessions": [
      {
        "type": "openai-codex",
        "name": "Codex",
        "displayName": "OpenAI Codex",
        "description": "OpenAI Codex integration for VS Code"
        // canDelegate: NOT SET in analyzed version (26.5609.30741)
        // Newer versions / design intent: canDelegate: true (see registration flow below)
      }
    ],
    "customEditors": [
      {
        "viewType": "chatgpt.conversationEditor",
        "selector": [{ "filenamePattern": "openai-codex:/**/*" }]
      }
    ],
    "views": {
      "codexViewContainer": [{ "id": "chatgpt.sidebarView", "type": "webview" }]
    }
  }
}
```

### Registration flow: how the extension contributes the Codex agent

The extension can operate in two modes depending on whether `canDelegate` is set:

---

#### Mode A — `canDelegate: false` / absent → standalone webview mode

When `canDelegate` is absent (as in the analyzed version 26.5609.30741), `_enableContribution` only calls `_registerMenuItems`:

```typescript
// chatSessions.contribution.ts:699  _enableContribution(contribution, ext)
private _enableContribution(contribution, ext): void {
    if (contribution.canDelegate) {
        // NOT entered — canDelegate is absent
        this._registerAgent(contribution, ext);
        this._registerCommands(contribution);
    }
    this._registerMenuItems(contribution, ext);  // ← always runs
}
```

`_registerMenuItems` reads actions the extension has contributed to `MenuId.AgentSessionsCreateSubMenu` (scoped to `chatSessionType == 'openai-codex'`). If the extension contributed one:

```typescript
// chatSessions.contribution.ts:555
if (i === 0 && !contribution.canDelegate) {
    // Wraps the extension's own command as the 'openNewChatSessionExternal' bridge:
    registerNewSessionExternalAction(
        contribution.type,           // 'openai-codex'
        contribution.displayName,    // 'Codex'
        action.item.id               // e.g. 'openai.chatgpt.openNewSession'
    );
    // ↓ Registers: 'workbench.action.chat.openNewChatSessionExternal.openai-codex'
    //   When clicked → executes the extension's own command → opens extension's webview
}
```

The session picker uses `openNewChatSessionExternal.openai-codex` when `canDelegate=false`:

```typescript
// sessionTargetPickerActionItem.ts:187
commandId: contribution.canDelegate
    ? `workbench.action.chat.openNewChatSessionInPlace.${contribution.type}`
    : `workbench.action.chat.openNewChatSessionExternal.${contribution.type}`,
```

In **Mode A**, clicking Codex in the picker opens the extension's own webview. VS Code's `chatAgentService` and `chatServiceImpl` are not involved in the request path — all Codex interactions happen inside the webview (`chatgpt.sidebarView` / `chatgpt.conversationEditor`) communicating directly with its own backend.

**The "command not found" bug** ([microsoft/vscode#310624](https://github.com/microsoft/vscode/issues/310624)) occurs when the extension has `canDelegate=false` but has NOT contributed a menu item to `AgentSessionsCreateSubMenu`. In this case:
- `_registerMenuItems` finds no menu actions → `registerNewSessionExternalAction` is never called
- `openNewChatSessionExternal.openai-codex` is never registered
- Session picker tries to execute it → `ERR command not found`

This matches what was observed: the Codex entry appeared in the picker (from the static `chatSessions` declaration) but clicking did nothing.

---

#### Mode B — `canDelegate: true` → routes through VS Code's chat agent service

When the extension declares `canDelegate: true`, `_enableContribution` runs the full registration:

**Phase 1 — Static declaration processed by `_enableContribution`:**
```typescript
// chatSessions.contribution.ts:703
if (contribution.canDelegate) {
    // 1a. Registers agent DATA (metadata only — no implementation yet):
    this._registerAgent(contribution, ext);
    // ↓ chatAgentService.registerAgent('openai-codex', {
    //     id: 'openai-codex', name: 'Codex', fullName: 'OpenAI Codex',
    //     extensionId: 'openai.chatgpt', isDefault: false, isDynamic: true,
    //     locations: [Chat], modes: [Agent, Ask], ...
    //   })
    // impl = undefined at this point — data-only entry

    // 1b. Registers in-place session commands:
    this._registerCommands(contribution);
    // ↓ Registers:
    //   'workbench.action.chat.openNewChatSessionInPlace.openai-codex'  ← picker uses this
    //   'workbench.action.chat.openNewSessionEditor.openai-codex'
    //   'workbench.action.chat.openNewSessionSidebar.openai-codex'
    //   'workbench.action.chat.openSessionWithPrompt.openai-codex'
}
this._registerMenuItems(contribution, ext); // adds to ChatNewMenu
```

**Phase 2 — Runtime registration when extension activates:**

The extension calls the proposed API. VS Code's `mainThreadChatAgents2.$registerAgent` handles it:

```typescript
// mainThreadChatAgents2.ts:338  $registerAgent(handle, extension, id='openai-codex', ...)
async $registerAgent(...) {
    // Gate: at least one of these must exist:
    const staticAgentRegistration = chatAgentService.getAgent('openai-codex', true);
    //  ↑ exists because Phase 1 called _registerAgent above
    const chatSessionRegistration = chatSessionService
        .getAllChatSessionContributions()
        .find(c => c.type === 'openai-codex');
    //  ↑ exists because extension's package.json declares chatSessions
    // → gate passes, proceed

    const impl: IChatAgentImplementation = {
        invoke: async (request, progress, history, token) => {
            // Calls back into the extension host:
            return this._proxy.$invokeAgent(handle, request, { history, chatSessionContext }, token);
            // ↓ ExtHostChatAgents2.$invokeAgent → extension's requestHandler runs
        },
    };

    // Register the IMPLEMENTATION (data was already registered in Phase 1):
    disposable = chatAgentService.registerAgentImplementation('openai-codex', impl);
    // chatAgentService._agents.get('openai-codex') now has both data + impl
}
```

**Phase 2 request chain when user sends a message:**

```
User clicks Codex in picker → openNewChatSessionInPlace.openai-codex
    → VS Code opens chat session with type 'openai-codex'

User sends message
    → chatAgentService.invokeAgent('openai-codex', request, progress, history, token)
    → data.impl.invoke(request, progress, history, token)        [from Phase 2 above]
    → mainThreadChatAgents2._proxy.$invokeAgent(handle, request, ..., token)  [IPC to ext host]
    → ExtHostChatAgents2.$invokeAgent → extension's requestHandler
    → extension calls progress.markdown(), progress.toolCall(), etc.
    → streamed back to VS Code chat UI
```

In Mode B, `chatSessionsService` is only used for **session content reading** (history hydration), not request routing:

```typescript
// History only — NOT used for requests:
chatSessionsService.getOrCreateChatSession('openai-codex://session-123', token)
    → provider.provideChatSessionContent(sessionResource, token)
    → Returns IChatSession { history: [...past turns...] }
    → chatServiceImpl uses history[] to populate ChatModel UI
// Requests always go through chatAgentService (above)
```

---

**Summary: `canDelegate` controls the entire registration path**

| | `canDelegate: false` (Mode A) | `canDelegate: true` (Mode B) |
|---|---|---|
| **Picker entry source** | Static `chatSessions` declaration | Static `chatSessions` declaration |
| **Picker command** | `openNewChatSessionExternal.<type>` | `openNewChatSessionInPlace.<type>` |
| **`openNewChatSessionExternal` registered?** | By `_registerMenuItems` (if ext has menu item) | By `_registerCommands` (always) |
| **Agent data in `chatAgentService`?** | ❌ No | ✅ Yes (Phase 1) |
| **Agent impl in `chatAgentService`?** | ❌ No | ✅ Yes (Phase 2) |
| **Request routing** | Extension's own webview (bypasses `chatAgentService`) | `chatAgentService.invokeAgent` → extension host |
| **Bug when missing** | `command not found` if no menu item | Extension activation failure / no impl registered |

### Authentication (Path A)

The extension manages its own auth — OpenAI API key or OAuth to openai.com. No Copilot token involved.

### How the extension reaches VS Code Insiders

Microsoft's VS Code Insiders `product.json` includes `openai.chatgpt` in `builtInExtensionsEnabledWithAutoUpdates`. VS Code fetches and installs it automatically. The OSS `product.json` in this repo does NOT contain this entry.

Verified from OSS `product.json`:
```json
// OSS product.json — only GitHub.copilot-chat is auto-installed
"builtInExtensionsEnabledWithAutoUpdates": [
    "GitHub.copilot-chat"
]
```

Verified from copilot `package.json` (line 6710) — the copilot extension does NOT register `openai-codex`:
```json
// extensions/copilot/package.json — chatSessions contributions
// Only: copilotcli, claude-code, copilot-cloud-agent
// openai-codex is ABSENT
```

### Authentication and models (Path A)

In both Mode A and Mode B, the extension manages its own authentication — direct OpenAI API key or OpenAI account login. Models are from **OpenAI directly**, not from Copilot CAPI. Copilot Pro+ is required because it unlocks access to the `openai.chatgpt` extension's premium features; the models themselves are OpenAI models billed through OpenAI.

---

## 4. Path B: Agent-Host — complete architecture

Path B is entirely built into VS Code (no external extension). It downloads and runs `@openai/codex` SDK locally, proxies all API calls through Copilot CAPI, and dispatches requests through the standard `chatAgentService.invokeAgent` mechanism — the same pipeline used by `copilotcli` and `claude-code`.

---

### 4.1 Startup gate (agent-host process)

```typescript
// src/vs/platform/agentHost/node/agentHostMain.ts:190–210
if (
    isAgentEnabled(process.env[AgentHostCodexAgentEnabledEnvVar], false) &&
    //             ↑ env: VSCODE_AGENT_HOST_CODEX_AGENT_ENABLED   ↑ default: false
    agentSdkDownloader.isAvailable(CodexSdkPackage)
) {
    agentService.registerProvider(new CodexAgent(...));
}
```

```typescript
// src/vs/platform/agentHost/node/agentSdkDownloader.ts:185
isAvailable(pkg: IAgentSdkPackage): boolean {
    if (process.env[pkg.devOverrideEnvVar]) return true; // VSCODE_AGENT_HOST_CODEX_SDK_ROOT
    return !!this._productService.agentSdks?.[pkg.id]   // absent in OSS product.json
        && resolveSdkTarget(pkg) !== undefined;
}
```

`VSCODE_AGENT_HOST_CODEX_SDK_ROOT` is set by the agent host starter from the user setting `chat.agentHost.codexAgent.sdkRoot` (via `buildAgentSdkEnv`). So there are **three ways** `isAvailable` can return `true`:

1. **User-installed**: user sets `chat.agentHost.codexAgent.sdkRoot` to an absolute path containing a `node_modules/@openai/codex` subtree (installed via e.g. `npm install -g @openai/codex`). The starter forwards it as `VSCODE_AGENT_HOST_CODEX_SDK_ROOT`.
2. **On-demand download**: `product.agentSdks.codex` is populated in the product config (absent from OSS `product.json`). The agent host downloads the SDK on first use.
3. **Dev env override**: `VSCODE_AGENT_HOST_CODEX_SDK_ROOT` set directly in the environment (bypasses the setting).

The binary is not bundled with VS Code — it must come from one of these three sources.

When the gate passes:
- `CodexProxyService` is created — HTTP proxy on `localhost:N`, nonce generated
- `@openai/codex` SDK loaded from the resolved root (user-installed path or downloaded cache)
- `CodexAgent` registers itself with the agent host service, announcing `{ provider: 'openai-codex', models: [...] }`

---

### 4.2 Workbench registration chain

The workbench side (`agentHostChatContribution.ts`) listens for the agent host service announcing available agents and calls `_registerAgent(agent)` per provider. For Codex:

```typescript
// src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostChatContribution.ts:225
const sessionType = `agent-host-${agent.provider}`;  // 'agent-host-openai-codex'
const agentId    = sessionType;                       // 'agent-host-openai-codex'
const vendor     = sessionType;                       // 'agent-host-openai-codex'
```

The registration happens in four steps:

**Step 1 — Session contribution (with `canDelegate: true`):**
```typescript
chatSessionsService.registerChatSessionContribution({
    type: 'agent-host-openai-codex',
    canDelegate: true,          // ← required for agent registration
    requiresCustomModels: true,
    supportsAutoModel: ...,
    capabilities: { supportsCheckpoints, supportsPromptAttachments, ... },
});
// This triggers chatSessions.contribution.ts:_enableContribution
//   → _registerAgent → chatAgentService.registerAgent('agent-host-openai-codex', data)
//   DATA registered, impl = undefined at this point
```

**Step 2 — `AgentHostSessionHandler` construction (impl registration):**
```typescript
const sessionHandler = new AgentHostSessionHandler({
    agentId:     'agent-host-openai-codex',
    sessionType: 'agent-host-openai-codex',
    connection:  this._agentHostService,  // IPC channel to agent-host process
    ...
});
// Constructor immediately calls this._registerAgent():
//   chatAgentService.registerDynamicAgent(agentData, {
//     invoke: (req, prog, hist, tok) => this._invokeAgent(req, prog, tok)
//   })
// This OVERWRITES the data-only entry with data+impl.
// chatAgentService._agents.get('agent-host-openai-codex') now has impl.
```

**Step 3 — Session content provider (history reading only):**
```typescript
chatSessionsService.registerChatSessionContentProvider(
    'agent-host-openai-codex',
    sessionHandler   // AgentHostSessionHandler also implements IChatSessionContentProvider
);
// provideChatSessionContent() → reads turn history from agent-host process
// NOT used for request routing — that goes through chatAgentService (Step 2)
```

**Step 4 — Language model provider (session type availability + in-session model picker):**
```typescript
const modelProvider = new AgentHostLanguageModelProvider(sessionType, vendor);
languageModelsService.registerLanguageModelProvider(vendor, modelProvider);
modelProvider.updateModels(agent.models);  // agent.models = IAgentModelInfo[] from CodexAgent

// provideLanguageModelChatInfo() re-wraps each model with:
//   { vendor: 'agent-host-openai-codex', targetChatSessionType: 'agent-host-openai-codex', ... }
//
// sendChatRequest() → throws Error('Agent-host models do not support direct chat requests')
// ← this provider is NEVER used for actual API calls
```

> **This is NOT a real language model provider in the general-picker sense.** Models with `targetChatSessionType` set are **intentionally hidden from general model pickers** — `defaultModelContribution.ts:123` explicitly filters them out with the comment "Models scoped to a specific chat session type (e.g. agent-host providers) are intentionally hidden from general model pickers."
>
> The `targetChatSessionType` field serves two specific purposes:
> 1. **Session type availability**: `sessionTypeAvailability.ts` calls `hasModelsTargetingSessionType()` — if any model targets `'agent-host-openai-codex'`, the session type appears as Available in the **session type picker**.
> 2. **In-session model picker**: once inside a Codex session, `filterModelsForSession` shows ONLY models with `targetChatSessionType === 'agent-host-openai-codex'`, giving the user a choice of which Codex model to use.

```typescript
// agentHostLanguageModelProvider.ts — the key field in provideLanguageModelChatInfo():
{
    identifier: `agent-host-openai-codex:codex-1`,
    metadata: {
        vendor: 'agent-host-openai-codex',
        targetChatSessionType: 'agent-host-openai-codex',  // drives (1) session availability + (2) in-session picker
        // ... same model name/id/context window as the CAPI model
    }
}
// defaultModelContribution.ts:123 — explicit filter:
//   if (model.metadata?.targetChatSessionType !== undefined) { return false; }
//   // "...intentionally hidden from general model pickers"
```

---

### 4.3 Session type selection → session creation

Models with `targetChatSessionType` set are **not shown in the general model picker** — they are hidden from normal sessions. The flow is instead:

```
[Session type picker — not the model picker]

sessionTypeAvailability.ts checks: hasModelsTargetingSessionType(languageModelsService, 'agent-host-openai-codex')
    → iterates all registered models
    → AgentHostLanguageModelProvider has models with targetChatSessionType='agent-host-openai-codex'
    → returns true → session type marked Available
    → 'agent-host-openai-codex' appears as an option in the session TYPE picker

User selects the Codex session type
    → VS Code creates a new session with sessionType = 'agent-host-openai-codex'

[In-session model picker — only within the Codex session]

filterModelsForSession(allModels, sessionType='agent-host-openai-codex', ...)
    → hasModelsTargetingSession(models, 'agent-host-openai-codex') = true
    → returns ONLY models with targetChatSessionType === 'agent-host-openai-codex'
    → normal Copilot models (no targetChatSessionType) are excluded from this picker
    → user picks which Codex model to use within the session

User sends message → chatAgentService.invokeAgent('agent-host-openai-codex', ...)
    // requests go through chatAgentService, NOT languageModelsService.sendChatRequest()
```

**Why models are hidden from the general picker** — verified from `defaultModelContribution.ts:123`:
```typescript
// Models scoped to a specific chat session type (e.g. agent-host
// providers) are intentionally hidden from general model pickers.
if (model.metadata?.targetChatSessionType !== undefined) {
    return false;  // excluded from general picker
}
```

---

### 4.4 First message: history hydration via `provideChatSessionContent`

```
chatServiceImpl.loadRemoteSession('agent-host-openai-codex://...', location, token)
    → chatSessionsService.getOrCreateChatSession(sessionResource, token)
        → agentHostSessionHandler.provideChatSessionContent(sessionResource, token)
          → IPC call to agent-host process
          → Returns IChatSession {
               history: [...existing turns from agent-host thread state...],
               progressObs,           // observable for streaming progress
               isCompleteObs,         // observable for completion state
               interruptActiveResponseCallback,
               onDidStartServerRequest,
            }
    → chatServiceImpl uses history[] to populate ChatModel
    → isAgentHostTarget('agent-host-openai-codex') = true
      → special progress-streaming wiring (progressObs → ChatModel)
      → server-initiated turn handling (onDidStartServerRequest)
```

This is **read-only history hydration**. No requests are dispatched here.

---

### 4.5 Request dispatch: `chatAgentService.invokeAgent`

This is the request routing path — completely separate from `provideChatSessionContent`:

```
User sends message
    ↓
chatService.sendRequest(sessionResource, message, { agentIdSilent: 'agent-host-openai-codex' })
    ↓
chatServiceImpl._sendRequestAsync(model, sessionResource, parsedRequest, ...)
    → agent = chatAgentService.getAgent('agent-host-openai-codex')
    → chatAgentService.invokeAgent('agent-host-openai-codex', request, progressCallback, history, token)
      src/vs/workbench/contrib/chat/common/participants/chatAgents.ts:530
      → data.impl.invoke(request, progress, history, token)
    ↓
agentHostSessionHandler._invokeAgent(request, progress, token)
    → _ensureSessionSubscription(sessionKey)        [IPC subscription to agent-host]
    → _readEagerlyCreatedSessionState(session)      [picks up pre-created session state]
    → _ensurePendingMessageSubscription(...)        [wires up message streaming]
    → _watchForServerInitiatedTurns(session, ...)   [handles server-push turns]
    → [sends request over IPC channel to agent-host process]
    ↓
Agent-host process: CodexAgent receives request
```

Key code (verified):
```typescript
// agentHostSessionHandler.ts:768
private _registerAgent(): void {
    const agentData: IChatAgentData = {
        id: this._config.agentId,  // 'agent-host-openai-codex'
        ...
    };
    const agentImpl: IChatAgentImplementation = {
        invoke: async (request, progress, _history, cancellationToken) => {
            return this._invokeAgent(request, progress, cancellationToken);
        },
    };
    this._register(this._chatAgentService.registerDynamicAgent(agentData, agentImpl));
}
```

---

### 4.6 Agent-host process: `CodexAgent` → SDK → CAPI

Each sub-section names the **`CodexAgent` method** responsible, followed by the exact JSON-RPC method and payload sent to the codex app-server.

---

#### Step 0 — `CodexAgent._refreshModels(token)` — CAPI only, no app-server

Called during init, after the Copilot token arrives via `authenticate()`. No app-server is involved.

```typescript
// codexAgent.ts:714  _refreshModels(token)
const all = await this._copilotApiService.models(token, { suppressIntegrationId: true });
// Filter to models with '/responses' in supported_endpoints (drops chat-completions-only)
const models = all.filter(m => m.supported_endpoints?.includes(CODEX_RESPONSES_ENDPOINT));
this._models.set(models, undefined);
```

Network: `GET api.github.com/copilot/models` with Copilot Bearer token. App-server not yet spawned.

---

#### Step 1 — `CodexAgent.createSession(config)` → provisional, prewarm scheduled

```typescript
// codexAgent.ts:1508  createSession(config)
// Returns immediately — no RPC sent yet
return { session: sessionUri, workingDirectory: config.workingDirectory, provisional: true };
// Schedules prewarm: after createSession returns, _schedulePrewarm() calls
// _materializeIfNeeded() in the background (starts connection + thread/start
// with a 60 s TTL). prewarmClaimed = false until the first sendMessage().
```

App-server child process spawned during the prewarm in the background. See Step 2 for the spawn details.

---

#### Step 2 — `CodexAgent._startConnection(token)` → spawn + `initialize` + `initialized`

Called from `_ensureConnection()`, which is called from `_materializeIfNeeded()` (triggered by prewarm or the first `sendMessage`).

**Binary spawn:**
```
codexAgent.ts:840  spawn(binaryPath, args, { env, stdio: ['pipe','pipe','pipe'] })

args:
  app-server
  -c  model_provider="vscode-proxy"
  -c  model_providers.vscode-proxy.name="VS Code Proxy"
  -c  model_providers.vscode-proxy.base_url="http://127.0.0.1:<PORT>/v1"
  -c  model_providers.vscode-proxy.wire_api="responses"
  -c  model_providers.vscode-proxy.env_key="OPENAI_API_KEY"
  -c  model_providers.vscode-proxy.requires_openai_auth=false
  -c  model_providers.vscode-proxy.supports_websockets=false
  -c  features.tool_call_mcp_elicitation=false
  [... user binaryArgs appended last ...]

env:
  ...process.env                         // inherit all shell vars
  OPENAI_API_KEY = <proxyHandle.nonce>   // NOT a real key — proxy nonce
  CODEX_HOME = <userCodexHome>           // only if chat.agentHost.codexAgent.codexHome is set
```

**AppServer RPC — `initialize`:**
```typescript
// codexAgent.ts:874  client.request<'initialize'>('initialize', ...)
{
  "method": "initialize",
  "params": {
    "clientInfo": {
      "name": "vscode_agent_host",
      "title": "VS Code Agent Host",
      "version": "0.1.0"
    },
    "capabilities": {
      "experimentalApi": true,
      "requestAttestation": false,
      "optOutNotificationMethods": null
    }
  }
}
// → AppServer responds with its own capabilities
```

**AppServer notification — `initialized`:**
```typescript
// codexAgent.ts:878  client.notify<'initialized'>('initialized', undefined)
{ "method": "initialized" }
```

**AppServer RPC — `account/login/start`** *(only when `chat.agentHost.codexAgent.codexHome` is set)*:
```typescript
// codexAgent.ts:885  client.request<'account/login/start'>('account/login/start', ...)
{
  "method": "account/login/start",
  "params": {
    "type": "apiKey",
    "apiKey": "<proxyHandle.nonce>"    // nonce, NOT a real key
  }
}
```

After these RPCs, `_connection` transitions: `idle → starting → ready`.

---

#### Step 3 — `CodexAgent._materialize(session)` → `thread/start`

Called from `_materializeIfNeeded()`. Sends `thread/start` to the connected app-server.

```typescript
// codexAgent.ts:1622  conn.client.request<'thread/start', { thread: { id: string } }>('thread/start', ...)
{
  "method": "thread/start",
  "params": {
    "cwd": "/path/to/workspace",       // session.workingDirectory.fsPath
    "model": "gpt-4o",                 // resolved from session config
    "approvalPolicy": "on-request",    // from CodexSessionConfigKey.ApprovalPolicy
    "sandbox": "workspace-write",      // from CodexSessionConfigKey.SandboxMode
    "config": {
      "web_search": "auto"             // from CodexSessionConfigKey.WebSearchMode
    },
    "dynamicTools": [                  // optional — built from server tools + client tools
      {
        "name": "tool_name",
        "description": "...",
        "inputSchema": { "type": "object", ... }
      }
    ]
  }
}
// ← response: { "thread": { "id": "<threadId>" } }
```

`session.threadId` is set from the response. If `session.disposed` is true by the time it returns, `thread/unsubscribe` is sent immediately to clean up the orphan thread.

`_persistMaterializedSession()` then writes `{ threadId, cwd, modelId }` to `codexSessionMetadataStore`.

---

#### Step 4 — `CodexAgent.sendMessage(sessionUri, prompt, ...)` → `thread/resume` (if needed) + `turn/start`

```typescript
// codexAgent.ts:1745  sendMessage(sessionUri, prompt, attachments?, turnId?)
```

**Optional — `thread/resume`** (only when `session.needsResume = true`, i.e. restored from `codexSessionMetadataStore` after a restart):
```typescript
// codexAgent.ts:1800  conn.client.request<'thread/resume'>('thread/resume', ...)
{
  "method": "thread/resume",
  "params": {
    "threadId": "<threadId>"
  }
}
```

**AppServer RPC — `turn/start`:**
```typescript
// codexAgent.ts:1819  conn.client.request<'turn/start'>('turn/start', ...)
{
  "method": "turn/start",
  "params": {
    "threadId": "<threadId>",
    "input": [
      { "type": "text", "text": "user prompt text" }
      // or { "type": "image_url", "image_url": { "url": "..." } } for attachments
    ],
    "model": "gpt-4o",                 // re-resolved per turn (may change mid-session)
    "approvalPolicy": "on-request",    // from _turnStartOptions()
    "sandboxPolicy": { ... },          // from _turnStartOptions()
    "effort": "medium",                // ReasoningEffort — from _turnStartOptions()
    "personality": "default",          // from _turnStartOptions()
    "summary": "auto",                 // from _turnStartOptions()
    "collaborationMode": {             // from _turnStartOptions() — drives Plan vs Interactive
      "mode": "default",
      "settings": {
        "model": "gpt-4o",
        "reasoning_effort": "medium",
        "developer_instructions": null
      }
    },
    "runtimeWorkspaceRoots": [...]     // only present for workspaceWrite sandboxPolicy
  }
}
// Does NOT await turn completion — turn/completed notification arrives asynchronously
```

After `turn/start` returns, `session.firstTurnSent = true`, which freezes `dynamicTools` for the lifetime of the thread.

---

#### Step 5 — Streaming: AppServer notifications → VS Code Chat UI

All notifications carry `threadId`. `_dispatchByThread(threadId, handler)` routes each to the matching `ICodexSession`. Each handler returns `(SessionAction | ChatAction)[]` which is fired via `this._fire(sessionUri, action)` to drive the VS Code Chat UI.

---

##### 5-A: How actions travel from the agent-host process to visual effects

The actions returned by the mapper are **not** sent to the Chat UI directly. They travel through a 4-layer pipeline:

```
[Agent-host utility process]
  codexMapAppServerEvents.ts: AppServer notification → (SessionAction | ChatAction)[]
  codexAgent.ts: this._fire(sessionUri, action)
      → IPC channel → AgentService.dispatch(sessionUri, action)
        ↓
[Workbench renderer process]
  IAgentConnection.dispatch(sessionUri, action)
      → Updates the replicated server-side state graph:
          SessionState.activeTurn.responseParts[]   ← per-part mutation
          SessionState.activeTurn.usage             ← token counts
          SessionState.activeTurn.toolCalls[]       ← per-tool-call state
        ↓
  AgentHostSessionHandler._observeTurn() — reactive observable graph
      turn$ = derived(state$ → state.activeTurn where id === turnId)
      responseParts$ = derived(turn$ → turn.responseParts)
        ↓
  autorun per response part → produces IChatProgress[]
  sink(IChatProgress[]) called — the sink IS the progress callback
  passed to chatAgentService.invokeAgent() (or appendProgress for server turns)
        ↓
  chatServiceImpl.acceptResponseProgress(request, parts)
      → ChatModel updates in-memory request/response
      → ChatWidget observes ChatModel via onDidChange
      → Chat UI re-renders: markdown bubble / tool call badge / reasoning block / usage footer
```

The critical element is that **the agent-host uses a replicated state machine**, not a live stream. Each `SessionAction/ChatAction` mutates a local copy of `SessionState`, and VS Code's reactive observables (built with `autorun`/`derived`) translate state changes into `IChatProgress[]` deltas.

---

##### 5-B: The observable graph inside `_observeTurn`

`AgentHostSessionHandler._observeTurn(opts)` installs the reactive graph once per turn:

```typescript
// agentHostSessionHandler.ts:1425  _observeTurn(opts)
//
// Derived observables:
//   turn$         = activeTurn where id === opts.turnId (or completed turn)
//   responseParts$ = turn$.responseParts[]
//   usage$         = turn$.usage
//   inputRequests$ = mergedState$.inputRequests[]
//
// Per response part — autorunPerKeyedItem keyed by part id:
//   MarkdownResponsePart  → _setupMarkdownPart()
//     autorun: content.length > lastEmitted → sink([{ kind: 'markdownContent', content: delta }])
//
//   ReasoningResponsePart → _setupReasoningPart()
//     autorun: content.length > lastEmitted → sink([{ kind: 'thinking', value: delta }])
//
//   ToolCallResponsePart  → _setupToolCallPart()
//     (see 5-C below)
//
// Usage autorun:
//   usage$ changes → sink([{ kind: 'usageData', promptTokens, completionTokens, ... }])
//
// Turn completion autorun:
//   activeTurn.id no longer === opts.turnId → opts.onTurnEnded(lastTurn) → Promise resolves
```

**Key property**: Markdown parts emit only the *delta* since the last autorun — `content.substring(lastEmitted)`. This means each autorun firing corresponds to exactly one `{ kind: 'markdownContent', content: '<new text>' }` progress item, replicating the streaming feel of a traditional participant without any extra buffering.

---

##### 5-C: Tool call visual lifecycle

Tool calls go through three distinct UI phases driven by state changes:

```
Phase 1 — ChatToolCallStart (from item/started → itemToToolCall entry):
  → ChatModel creates a pending IChatToolInvocation
  → UI: "Running shell command..." spinner badge appears

Phase 2 — ChatToolCallContentChanged (from outputDelta/patchUpdated/progress):
  → IChatToolInvocation.updateContent(output)
  → UI: tool output populates inside the badge in real-time

Phase 3 — ChatToolCallComplete (from item/completed):
  → IChatToolInvocation.finish(result: { success, pastTenseMessage, content })
  → UI: spinner stops, badge shows 'Ran `cmd`' / 'Applied file changes' / 'Called tool'
       with green ✓ or red ✗ depending on success
```

For `commandExecution`, there is also an intermediate `ChatToolCallReady` that signals VS Code to apply the `approvalPolicy` gate:

```
item/started → ChatToolCallStart + ChatToolCallDelta + ChatToolCallReady
  → if approvalPolicy='on-request': UI shows approval dialog
    User confirms → dispatchAction(ChatToolCallConfirmed { approved: true })
    → agent-host receives confirmation → codex resumes execution
  → if approvalPolicy='never': NotNeeded → no dialog shown
item/commandExecution/outputDelta → ChatToolCallContentChanged (live output)
item/completed → ChatToolCallComplete (finalize with exit code)
```

---

##### 5-D: Reconnection — `activeTurnToProgress`

If VS Code restarts while a turn is in flight, `provideChatSessionContent` calls `activeTurnToProgress(sessionResource, activeTurn, connectionAuthority)` to reconstruct the current visual state from the hydrated `SessionState`:

```typescript
// stateToProgressAdapter.ts:442  activeTurnToProgress()
// Reads activeTurn.responseParts[] and synthesizes IChatProgress[] from them:
//   MarkdownResponsePart  → { kind: 'markdownContent', content: fullText }
//   ReasoningResponsePart → { kind: 'thinking', value: fullText }
//   ToolCallResponsePart  → toolCallStateToInvocation(tc) → IChatToolInvocationSerialized
```

The `_observeTurn` graph then seeds `opts.seedEmittedLengths` from these snapshot lengths, so subsequent deltas from live notifications continue from the right offset without re-emitting already-shown content.

---

##### 5-E: Comparison with traditional chat participants (`@copilot`, `vscode.chat.createChatParticipant`)

| Dimension | Agent-host (Codex) | Traditional `createChatParticipant` |
|---|---|---|
| **Stream API** | `(SessionAction\|ChatAction)[]` → replicated state → `IChatProgress[]` via `autorun` | `IChatResponseStream.markdown()`, `.button()`, `.toolCall()` called directly in `invoke()` handler |
| **Execution model** | **Pull**: VS Code observes server-side state; UI updates when state changes | **Push**: extension pushes progress items synchronously as they produce output |
| **Process boundary** | Agent runs in VS Code's own utility process (or IPC-attached process); state replicated to renderer via IPC | Extension runs in extension host process; `IChatResponseStream` methods cross IPC to the renderer |
| **Reconnection** | Full reconnection to in-flight turns via `activeTurnToProgress` + `_reconnectToActiveTurn`; state machine replays all current parts | None — if extension host restarts, in-flight turn is lost |
| **Server-initiated turns** | `_watchForServerInitiatedTurns` detects new `activeTurn` IDs not sent by this client; `chatSession.startServerRequest()` creates turn without user input | Not supported — only user input triggers `invoke()` |
| **State persistence** | Full `SessionState`/`ChatState` replicated to renderer; history via `turnsToHistory()` from server | History from local `ChatModel` only; `invoke()` receives it as `IChatRequestHistory[]` |
| **Tool confirmation** | `ChatToolCallReady { confirmed: NotNeeded\|PendingConfirmation }` → `_awaitToolConfirmation()` → dispatch `ChatToolCallConfirmed` back to server | `stream.confirmation()` → `IChatResponseStream` sends `IChatConfirmation`; extension receives callback |
| **Reasoning / thinking** | `ReasoningResponsePart` → `{ kind: 'thinking', value: delta }` via `_setupReasoningPart` | `stream.markdown()` wrapping a custom thinking block — no first-class reasoning support |
| **Model** | Models hidden from general picker; session-type-specific; in-session model picker only | Any model from `lm.selectChatModels()` or user's default |
| **Registration** | `chatAgentService.registerDynamicAgent(data, impl)` — core-only API | `vscode.chat.createChatParticipant(id, handler)` — public extension API |
| **Approval gate** | Configured at `thread/start` (`approvalPolicy`); VS Code intercepts `ChatToolCallReady` | Extension manages approval in its own `invoke()` handler; can call `stream.confirmation()` for UI |
| **Usage tracking** | `thread/tokenUsage/updated` → `ChatUsage { inputTokens, outputTokens, cacheReadTokens, reasoningOutputTokens }` | `stream.usage(...)` if the extension chooses to emit it |

**The fundamental architectural difference:**

A traditional `@copilot` participant is **imperative**: when `invoke()` is called, the extension runs code, calls `stream.markdown('hello')`, calls `stream.toolCall(...)`, and the calls immediately produce UI. The participant is in control and VS Code just renders whatever it pushes.

The agent-host is **declarative and state-driven**: VS Code maintains a replicated `SessionState` graph. Codex's app-server notifications mutate that state via actions. VS Code's reactive observables (`autorun`/`derived`) watch for state changes and translate them into `IChatProgress[]`. This means:
- The UI can be **reconstructed at any time** by reading the current state (`activeTurnToProgress`)
- **Multiple observers** can watch the same state (e.g. `_observeTurn` for the current turn AND `_trackServerTurnProgress` for a server-initiated turn)
- **Turn history** is queryable server-side, not just locally
- **Cancellation** dispatches an action back to the server (`ChatTurnCancelled`), which the server-side state machine processes — VS Code doesn't cancel an in-flight promise

---

##### `turn/started` → `_handleTurnStartedNotification` → turn ID correlation, no UI action

```typescript
// codexAgent.ts:1166  _handleTurnStartedNotification(session, params)
// codexMapAppServerEvents.ts:195  mapTurnStarted(state, params, fallbackUserText)
//
// mapTurnStarted() sets state.currentTurnId = params.turn.id
// and calls resetCodexTurnMapState() — clears itemToPartId, itemToToolCall, itemToReasoningPartId
//
// Returns [] — the workbench already fired ChatTurnStarted before sendMessage();
// this notification only establishes the app-server ↔ host turn ID correlation.
```

---

##### `item/started` → `_handleItemStarted` → opening shell for each item type

`userMessage` items are handled separately (steering promotion only — the turn opener is silently dropped). All other item types call `mapItemStarted`:

```
item.type === 'agentMessage'
  → allocates partId, sets itemToPartId[item.id] = partId
  → fires: ChatResponsePart { kind: Markdown, id: partId, content: item.text ?? '' }
  // Opens an empty markdown bubble; deltas stream into it below

item.type === 'commandExecution'
  → allocates toolCallId, sets itemToToolCall[item.id]
  → fires: ChatToolCallStart  { toolName: 'shell', displayName: 'Run shell command', _meta: { toolKind: 'terminal' } }
           ChatToolCallDelta  { content: command }
           ChatToolCallReady  { invocationMessage: command, confirmed: NotNeeded, _meta: { toolKind: 'terminal' } }
  // Output streams in via item/commandExecution/outputDelta below

item.type === 'webSearch'
  → allocates toolCallId
  → fires: ChatToolCallStart  { toolName: 'web_search', displayName: 'Web search', _meta: { toolKind: 'search' } }
           ChatToolCallDelta  { content: query }
           ChatToolCallReady  { invocationMessage: query, confirmed: NotNeeded, _meta: { toolKind: 'search' } }

item.type === 'fileChange'
  → allocates toolCallId
  → fires: ChatToolCallStart  { toolName: 'file_edit', displayName: 'Apply file changes' }
           ChatToolCallDelta  { content: describeFileChange(changes) }
           ChatToolCallReady  { invocationMessage: summary, confirmed: NotNeeded }
           ChatToolCallContentChanged  { content: [{ type: Text, text: diff }] }   // only if non-empty

item.type === 'mcpToolCall'
  → allocates toolCallId, toolName = '<server>.<tool>'
  → fires: ChatToolCallStart  { toolName, displayName: item.tool }
           ChatToolCallDelta  { content: JSON.stringify(item.arguments) }
           ChatToolCallReady  { invocationMessage: 'Calling <server>.<tool>', confirmed: NotNeeded }

item.type === 'dynamicToolCall'    // VS Code tools registered via thread/start.dynamicTools
  → allocates toolCallId, toolName = '<namespace>.<tool>' (or bare name for server tools)
  → fires: ChatToolCallStart  { toolName, displayName: item.tool,
                                 contributor: { kind: Client, clientId } }  // omitted for server tools
           ChatToolCallDelta  { content: JSON.stringify(item.arguments) }
           ChatToolCallReady  { invocationMessage: 'Calling <tool>', confirmed: NotNeeded }
           ChatToolCallContentChanged  { content: [...] }   // only if item.contentItems non-empty
```

---

##### `item/agentMessage/delta` → `mapAgentMessageDelta` → incremental markdown text

```typescript
// codexMapAppServerEvents.ts:564
// Looks up partId = itemToPartId[params.itemId]
// → fires: ChatDelta { turnId, partId, content: params.delta }
// Each delta appends text to the open Markdown bubble opened by item/started.
// If itemId not yet in map (race), the delta is silently dropped.
```

---

##### `item/commandExecution/outputDelta` → `mapCommandExecutionOutputDelta` → accumulated shell output

```typescript
// codexMapAppServerEvents.ts:496
// entry = itemToToolCall[params.itemId]
// entry.output += params.delta   (accumulates full output)
// → fires: ChatToolCallContentChanged { toolCallId: entry.toolCallId,
//                                       content: [{ type: Text, text: entry.output }] }
// Replaces full content on each delta (not incremental append in the UI).
```

---

##### `item/fileChange/patchUpdated` → `mapFileChangePatchUpdated` → live diff preview

```typescript
// codexMapAppServerEvents.ts:513
// entry.output = fileChangeOutput(params.changes)   (replaces with latest patch)
// → fires: ChatToolCallContentChanged { content: [{ type: Text, text: diffs }] }
```

##### `item/fileChange/outputDelta` → `mapFileChangeOutputDelta` → incremental file output

```typescript
// codexMapAppServerEvents.ts:530
// entry.output += params.delta
// → fires: ChatToolCallContentChanged { content: [{ type: Text, text: entry.output }] }
```

---

##### `item/mcpToolCall/progress` → `mapMcpToolCallProgress` → MCP server progress

```typescript
// codexMapAppServerEvents.ts:547
// entry.output = [entry.output, params.message].filter(Boolean).join('\n')
// → fires: ChatToolCallContentChanged { content: [{ type: Text, text: entry.output }] }
```

---

##### `item/reasoning/summaryPartAdded` → `mapReasoningSummaryPartAdded` → opens thinking bubble

```typescript
// codexMapAppServerEvents.ts:219
// key = '<itemId>:summary:<summaryIndex>'
// If key not yet in itemToReasoningPartId:
//   allocates partId, sets itemToReasoningPartId[key] = partId
//   → fires: ChatResponsePart { kind: Reasoning, id: partId, content: '' }
// If key already exists: returns []   (idempotent)
```

##### `item/reasoning/summaryTextDelta` + `item/reasoning/textDelta` → `mapReasoningSummaryTextDelta` / `mapReasoningTextDelta` → reasoning content

```typescript
// codexMapAppServerEvents.ts:226, 237
// Both follow the same pattern:
// key = '<itemId>:summary:<index>' or '<itemId>:text:<index>'
// ensureReasoningPart() → may open a new Reasoning part (ChatResponsePart) if not already open
// → fires: ChatReasoning { turnId, partId, content: params.delta }
// Shown in VS Code as a collapsible "Thinking..." block.
```

---

##### `thread/tokenUsage/updated` → `mapTokenUsageUpdated` → usage display

```typescript
// codexMapAppServerEvents.ts:256
// params.tokenUsage.last = { inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens }
// → fires: ChatUsage {
//     inputTokens,
//     outputTokens,
//     cacheReadTokens: cachedInputTokens,
//     _meta: { reasoningOutputTokens, modelContextWindow }
//   }
// Displayed in the turn's usage footer.
```

---

##### `item/completed` → `mapItemCompleted` → finalizes each item

```
item.type === 'agentMessage'
  → deletes itemToPartId[item.id]   (GC — no UI action)

item.type === 'reasoning'
  → clears all itemToReasoningPartId entries for this itemId   (GC — no UI action)

item.type === 'commandExecution'
  → deletes itemToToolCall[item.id]
  → success = (status === 'completed' && exitCode ∈ {0, null})
  → fires: ChatToolCallComplete {
      success,
      pastTenseMessage: 'Ran `<cmd>`'          // or 'Ran `<cmd>` (exit N)' on failure
      content: [{ type: Text, text: aggregatedOutput }],
      error: { message: 'Exit code N' }        // only on failure
    }

item.type === 'webSearch'
  → fires: ChatToolCallComplete { success: true, pastTenseMessage: 'Searched <query>' }

item.type === 'fileChange'
  → success = (status === 'completed')
  → fires: ChatToolCallComplete {
      success,
      pastTenseMessage: 'Applied file changes' | 'Failed to apply file changes',
      content: [{ type: Text, text: diff }],
      error: { message: 'Patch <status>' }     // only on failure
    }

item.type === 'mcpToolCall'
  → success = (status === 'completed' && !item.error)
  → fires: ChatToolCallComplete {
      success,
      pastTenseMessage: 'Called <server>.<tool>' | 'Failed to call ...',
      content: [{ type: Text, text: mcpOutput }]
    }

item.type === 'dynamicToolCall'
  → success = (item.success === true || status === 'completed')
  → fires: ChatToolCallComplete {
      success,
      pastTenseMessage: 'Called <tool>' | 'Failed to call ...',
      content: [{ type: Text, text: output }]
    }
```

---

##### `turn/completed` → `_handleTurnCompletedNotification` → `mapTurnCompleted` → closes turn

```typescript
// codexAgent.ts:1173  _handleTurnCompletedNotification(session, params)
// codexMapAppServerEvents.ts:731  mapTurnCompleted(state, params)
//
// 1. Clears state.currentTurnId, itemToPartId, itemToReasoningPartId
// 2. Flushes any orphaned tool calls (never got item/completed — e.g. interrupted mid-tool):
//    → fires: ChatToolCallComplete { success: false, pastTenseMessage: 'Stopped <tool>',
//                                    error: 'Turn interrupted before the tool completed' }
//
// 3a. status === 'completed'  → fires: ChatTurnComplete { turnId }
// 3b. status === 'interrupted' → fires: ChatTurnCancelled { turnId }
// 3c. status === 'failed'      → fires: ChatError { errorType: 'CodexError', message }
//                                        ChatTurnComplete { turnId }
//
// After return: codexTurnIdByHostTurnId[hostTurnId] = appTurnId (persists for truncation)
//              hostTurnIdByAppTurnId[appTurnId] cleared
```

---

#### Step 6 — AppServer → `CodexProxyService` → CAPI

When the codex child process makes an HTTP call for a model response:

```
Codex child process:
  POST http://127.0.0.1:<PORT>/v1/responses
  Authorization: Bearer <nonce>
  Content-Type: application/json
  { "model": "gpt-4o", "stream": true, "input": [...] }
    ↓
CodexProxyService._handleRequest()
  → validates: authHeader === `Bearer ${runtime.nonce}` (401 if mismatch)
  → routes POST /v1/responses → _handleResponses()
    ↓
CodexProxyService._handleResponses()
  dispatchedToken = runtime.githubToken   // snapshot at dispatch time
  upstream = await this._copilotApiService.responses(
      dispatchedToken,
      body,
      { signal: entry.ac.signal, suppressIntegrationId: true }
  )
  → CAPI: POST api.github.com/copilot/responses
    Authorization: Bearer <copilot_token>
    body: passthrough (model, input, stream, etc.)
    ↓
  streams CAPI SSE chunks back to codex child process
```

---

### 4.7 Approval handling

Codex has **two orthogonal approval systems** that must be understood separately.

---

#### System 1 — Codex-native approval policy (`CodexSessionConfigKey.ApprovalPolicy`)

This is the primary approval system for Codex **native tool calls** (shell commands, file changes, permission escalations). It has nothing to do with the VS Code "Set permission" picker.

**Values** (`codexSessionConfigKeys.ts:25`):
```typescript
export type CodexApprovalPolicy = Extract<AskForApproval, 'never' | 'on-request' | 'on-failure' | 'untrusted'>;
```

| Value | Label | Behaviour |
|---|---|---|
| `'never'` | No Escalations | Never ask; commands that can't run in the sandbox are rejected |
| `'on-request'` | Ask When Needed **(default)** | Ask only when Codex determines elevated permission is needed |
| `'on-failure'` | Ask on Failure | Try in sandbox first; ask to retry with elevated permission if it fails |
| `'untrusted'` | Ask More Often | Ask before a broader set of command categories |

**How it reaches the app server** (`codexAgent.ts:685–704`):

```typescript
// _turnStartOptions() — called before every turn/start or turn/resume
private _turnStartOptions(session: ICodexSession, modelId: string) {
    const config = this._readSessionConfig(session);
    const approvalPolicy =
        narrowApprovalPolicy(config[CodexSessionConfigKey.ApprovalPolicy])
        ?? codexSessionConfigDefaults[CodexSessionConfigKey.ApprovalPolicy];
    // ...
    return { approvalPolicy, sandboxPolicy, ... };
}
```

`approvalPolicy` flows into `TurnStartParams` → sent as `thread/turn/start` JSON-RPC payload to the Codex app server. The Codex app server then decides internally whether a given tool call needs an approval request from VS Code.

---

#### System 2 — VS Code "Set permission" picker (`SessionConfigKey.AutoApprove`)

This is the **generic** agent-host approval system, visible as the "Set permission" dropdown in the chat widget. It has **three** levels:

| Picker label | `ChatPermissionLevel` value | `SessionConfigKey.AutoApprove` value |
|---|---|---|
| Default Approvals | `ChatPermissionLevel.Default` | `'default'` |
| Bypass Approvals | `ChatPermissionLevel.AutoApprove` | `'autoApprove'` |
| Autopilot | `ChatPermissionLevel.Autopilot` | `'autopilot'` |

**How the picker fires** (`chatSlashCommands.ts:231–257`):

```typescript
const setPermissionLevelForSession = async (sessionResource: URI, level: ChatPermissionLevel) => {
    // Respect a policy that prevents auto-approve being set
    const permittedLevel = configurationService.inspect<boolean>(ChatConfiguration.GlobalAutoApprove)
        .policyValue === false ? ChatPermissionLevel.Default : level;
    const partial = { [SessionConfigKey.AutoApprove]: permittedLevel };
    // Dispatch SessionConfigChanged → propagates to the agent-host process
    await agentHostSessionHandler.dispatch(sessionResource, {
        type: ActionType.SessionConfigChanged,
        values: partial,
    });
    widget.input.setPermissionLevel(level);  // updates widget UI
};
```

**How it's evaluated** (`sessionPermissions.ts:125–165`):

```typescript
getAutoApproval(e, sessionKey): ToolCallConfirmationReason | undefined {
    // 1. Session-level auto-approve (driven by Set Permission picker)
    if (this._isSessionAutoApproveEnabled(sessionKey)) {
        return ToolCallConfirmationReason.Setting;  // auto-approve
    }
    // 2. Per-tool session permissions (previously granted via "Allow in this Session")
    // 3. Read-path auto-approve
    // 4. Write-path auto-approve
    // 5. Shell command patterns
    return undefined;  // needs user confirmation
}

private _isSessionAutoApproveEnabled(sessionKey): boolean {
    const level = this._readSessionConfig(sessionKey)[SessionConfigKey.AutoApprove];
    return level === 'autoApprove' || level === 'autopilot';
}
```

**Critically**: This evaluation only runs when the tool call arrives via the **generic `_handleToolReady()` path** in `agentSideEffects.ts` — which is triggered by `pending_confirmation` signals from the agent SDK (used by CopilotAgent). **Codex native tool calls do NOT use this path.**

---

#### How Codex approval requests propagate to VS Code (the real flow)

When the Codex app server decides it needs approval, it sends a **JSON-RPC request** back to VS Code (the host). VS Code's `CodexAgent` handles three request types:

| JSON-RPC method | Params type | What it guards |
|---|---|---|
| `commandExecution/requestApproval` | `CommandExecutionRequestApprovalParams` | Shell command execution |
| `fileChange/requestApproval` | `FileChangeRequestApprovalParams` | File writes / patch apply |
| `permissions/requestApproval` | `PermissionsRequestApprovalParams` | Network / filesystem escalation |

**`_handleCommandApprovalRequest()` — the core handler** (`codexAgent.ts:1352–1390`):

```typescript
private async _handleCommandApprovalRequest(params: {
    threadId, turnId, itemId, command?, reason?
}): Promise<CommandExecutionApprovalDecision> {
    // 1. Resolve session from threadId
    const entry = session.mapState.itemToToolCall.get(params.itemId);

    // 2. Accept-for-session memo: auto-approve without prompting
    //    if the user previously accepted this exact command in this session
    if (command && session.acceptedForSession.has(command)) {
        return 'acceptForSession';
    }

    // 3. Atomically register the deferred AND fire ChatToolCallReady
    //    so a synchronous responder can't miss the registration.
    const decision = await session.pendingCommandApprovals.registerAndFire(
        entry.toolCallId,
        () => {
            this._fire(session.sessionUri, {
                type: ActionType.ChatToolCallReady,   // fires to VS Code state machine
                turnId: entry.turnId,
                toolCallId: entry.toolCallId,
                invocationMessage: command,           // shown as "Run: <command>"
                toolInput: command,
                confirmationTitle,
            });
        }
    );

    // 4. Track accept-for-session decisions
    if (decision === 'acceptForSession' && command) {
        session.acceptedForSession.add(command);
    }
    return decision;  // 'accept' | 'decline' | 'acceptForSession'
}
```

**Key observation**: `this._fire()` sends `ChatToolCallReady` **directly to the VS Code state machine**, bypassing `agentSideEffects._handleToolReady()`. This means the "Set permission" picker's auto-approve logic has **no effect** on Codex native tool approvals.

---

#### How the user response flows back to the Codex app server

When VS Code receives `ChatToolCallReady`, the chat UI renders an approval card with options (Allow / Deny / Allow for Session). When the user clicks:

```
User clicks "Allow" / "Deny" / "Allow for Session"
    ↓
VS Code dispatches ActionType.ChatToolCallConfirmed {
    toolCallId,
    approved: true | false,
    selectedOptionId: 'acceptForSession' | undefined
}
    ↓
agentSideEffects.handleAction() (agentSideEffects.ts:795–808):
    const agentId = this._toolCallAgents.get(`${channel}:${action.toolCallId}`);
    agent?.respondToPermissionRequest(action.toolCallId, action.approved);
    // If approved: also call handleToolCallConfirmed() to persist for future calls
    if (action.approved) {
        this._permissionManager.handleToolCallConfirmed(channel, action.toolCallId, action.selectedOptionId);
    }
    ↓
codexAgent.respondToPermissionRequest(requestId, approved) (codexAgent.ts:2053):
    // Iterate all sessions, find the pending deferred keyed by toolCallId
    session.pendingCommandApprovals.respond(requestId, approved ? 'accept' : 'decline')
    ↓
PendingRequestRegistry resolves the await in _handleCommandApprovalRequest
    → returns 'accept' | 'decline' | 'acceptForSession' to the RPC handler
    ↓
_handleCommandApprovalRequestRpc returns { result: { decision } } to Codex app server
    ↓
Codex app server executes (or skips) the shell command based on decision
```

---

#### How the two systems interact — summary table

| Dimension | Codex-native (`CodexSessionConfigKey.ApprovalPolicy`) | VS Code picker (`SessionConfigKey.AutoApprove`) |
|---|---|---|
| **Scope** | Shell commands, file writes, permission escalation | MCP tools (via `pending_confirmation` signal) |
| **Where evaluated** | Codex app server (decides whether to send the RPC) | `agentSideEffects._handleToolReady()` |
| **Auto-approve trigger** | `session.acceptedForSession` (per-command session memory) | `isSessionAutoApproveEnabled()` → `'autoApprove'` or `'autopilot'` |
| **UI path** | `_fire(ChatToolCallReady)` directly from `_handleCommandApprovalRequest` | `_permissionManager.createToolReadyAction()` inside `_handleToolReady` |
| **User response** | `ChatToolCallConfirmed` → `respondToPermissionRequest()` → deferred resolves → JSON-RPC response | `ChatToolCallConfirmed` → `respondToPermissionRequest()` → same path, but original deferred is in the agent SDK |
| **Session persistence** | `session.acceptedForSession.add(command)` in-memory per session | `handleToolCallConfirmed()` persists in `SessionPermissionManager` |
| **"Bypass Approvals" effect** | **None** — does not affect Codex native tool calls | Auto-approves MCP tools without showing UI |

#### Comparison: Codex vs traditional chat participant approval

| Dimension | Codex (agent-host) | Traditional participant (`@copilot`) |
|---|---|---|
| **Approval trigger** | Codex app server sends JSON-RPC `commandExecution/requestApproval` | Agent SDK emits `pending_confirmation` signal to VS Code |
| **Who intercepts** | `codexAgent._handleCommandApprovalRequestRpc()` | `agentSideEffects._handleToolReady()` |
| **Auto-approve gate** | `session.acceptedForSession` (per-command) | `SessionPermissionManager.getAutoApproval()` (Set Permission picker) |
| **User response flow** | `ChatToolCallConfirmed` → `respondToPermissionRequest()` → JSON-RPC deferred | `ChatToolCallConfirmed` → `handleToolCallConfirmed()` → permission persisted |
| **Persistence** | In-memory per session (`acceptedForSession` Set) | `SessionPermissionManager` (persisted via `_persistSessionFlag`) |
| **Granularity** | Per exact command string | Per tool name + option ID |

---

### 4.8 Session persistence (across restarts)

`codexSessionMetadataStore` durably maps session URI → `{ threadId, lastTurnId, model }`. On restart:
- `provideChatSessionContent` reads thread history from agent-host via `threadId`
- `thread/resume` re-attaches to an existing thread (if `needsResume` flag is set)
- History is re-hydrated into the ChatModel for display

---

### 4.9 Key distinction: two separate interfaces on `AgentHostSessionHandler`

`AgentHostSessionHandler` implements **two completely separate interfaces**:

| Interface | Method | Purpose |
|---|---|---|
| `IChatSessionContentProvider` | `provideChatSessionContent(uri, token)` | Read past turns from agent-host thread state. Called once when session is opened. **Read-only.** |
| `IChatAgentImplementation` | `invoke(request, progress, history, token)` via `_invokeAgent` | Handle new user messages. Called on every request. **Write path.** |

VS Code core calls these through completely separate pipelines:
- History: `chatSessionsService.getOrCreateChatSession()` → `provideChatSessionContent()`
- Requests: `chatAgentService.invokeAgent()` → `_invokeAgent()`

---

## 5. Authentication — How Codex Gets Its Token

### Path A (extension-side)

The `openai.chatgpt` extension manages auth directly. It either:
- Uses the user's OpenAI API key
- Uses an OAuth login to openai.com

This is transparent to VS Code core. No Copilot token involved.

### Path B (agent-host) — The Nonce Proxy Pattern

This is the production-hardened path. The agent-host **never gives the Codex SDK a real OpenAI API key or Copilot token**. Instead:

```
Codex SDK
    ↓ Bearer <nonce>
CodexProxyService (in VS Code agent-host process)
    → validates nonce matches the current session
    → re-issues request to CAPI using current GitHub Copilot token
CAPI (api.github.com/copilot/*)
    ↓ responses
CodexProxyService
    ↓ proxied response
Codex SDK
```

Key code paths:

```typescript
// src/vs/platform/agentHost/node/codex/codexProxyService.ts
// The handle owns a nonce that the codex CLI passes as `Bearer <nonce>` on every request.
// The proxy validates that nonce, then re-issues the request to CAPI using the **current** GitHub Copilot token.
interface ICodexProxyHandle {
    baseUrl: string;    // local http://localhost:<port>
    nonce: string;      // used as Bearer token by SDK
}

// In codexProxyService._handleResponses():
this._copilotApiService.responses(dispatchedToken, body, {
    signal: entry.ac.signal,
    suppressIntegrationId: true
})
```

```typescript
// src/vs/platform/agentHost/node/codex/codexAgent.ts:815
// When spawning the Codex SDK:
env: {
    OPENAI_API_KEY: proxyHandle.nonce,    // ← nonce, not real key
    ...
}
// Plus in session config:
// requires_openai_auth: false             // ← disable SDK's own auth
```

**Why this matters**:
- The Copilot token is never exposed to the Codex SDK process
- The nonce rotates per proxy handle creation
- Copilot entitlement checks happen at CAPI, not in the SDK
- Token refresh is transparent — the proxy always uses the *current* Copilot token

### Authentication flow summary

```
1. User signed in to GitHub Copilot → IAuthenticationService has GitHub token
2. agentHostMain creates CodexProxyService
3. CodexProxyService creates proxy handle: { nonce: uuid, baseUrl: 'http://localhost:N' }
4. codexAgent spawns @openai/codex SDK with:
   - OPENAI_API_KEY = nonce
   - --api-base-url = proxyHandle.baseUrl
   - --no-openai-auth (requires_openai_auth=false in session config)
5. SDK makes HTTP requests to localhost:N with Bearer <nonce>
6. CodexProxyService validates nonce, calls CAPI with real Copilot token
7. CAPI response returned to SDK
```

---

## 6. Model Sourcing — CAPI or OpenAI Subscription?

### Path A (extension-side `openai-codex`)

Models come from **OpenAI API directly** via the `openai.chatgpt` extension. The extension registers models with `targetChatSessionType: 'openai-codex'` that it obtains through its own OpenAI API access. This is billed to the user's OpenAI account/subscription, enabled via Copilot Pro+ which unlocks the extension's features.

### Path B (agent-host)

Models come from **Copilot CAPI**, filtered to those supporting the `/responses` API endpoint:

```typescript
// src/vs/platform/agentHost/node/codex/codexAgent.ts:716
// _refreshModels() calls copilotApiService.models() — same Copilot model catalog
// Then filters: model.capabilities.includes('/responses') or similar
const token = await _ensureAuthenticated();
const models = await this._copilotApiService.models(token, { suppressIntegrationId: true });
// Filter to those supporting /responses endpoint
```

**Verification**: `agentHostStarter.config.contribution.ts` policy description explicitly states: "Uses your existing Copilot subscription."

**Implication**: For Path B, models are NOT billed to OpenAI separately — they go through the user's existing Copilot subscription quota.

---

## 7. Call Chain: Agent-Host Codex End-to-End

### Initialization

> **All steps below happen entirely in VS Code core (the agent-host utility process and the workbench contribution layer). The copilot-chat extension (`extensions/copilot/`) is not involved at all in the Codex path — it only registers `copilotcli`, `claude-code`, and `copilot-cloud-agent`.**

```
VS Code starts
    ↓
agentHostMain.ts starts agent host process  [VS Code core]
    ↓
Check: isAgentEnabled(AGENT_HOST_CODEX_ENABLED, false) && agentSdkDownloader.isAvailable(CodexSdkPackage)
    ↓ (if true)
CodexProxyService created  [VS Code core — codexProxyService.ts]
    → HTTP proxy listening on localhost:<port>
    → nonce slot allocated (token injected later after authenticate())
    ↓
CodexAgent constructed  [VS Code core — codexAgent.ts]
    → _connection = { kind: 'idle' }   ← app-server NOT spawned yet
    ↓
agentHostContribution: workbench side registers session type  [VS Code core workbench]
    → chatSessionsService.registerChatSessionContribution('agent-host-openai-codex', { canDelegate: true })
    → AgentHostSessionHandler created → chatAgentService.registerDynamicAgent(...)
    → chatSessionsService.registerChatSessionContentProvider(...)
    → AgentHostLanguageModelProvider registered with languageModelsService
    ↓
agentHostContribution: authenticate() called  [VS Code core]
    → GitHub Copilot token pushed to CodexAgent via authenticate()
    → CodexAgent._queueModelRefresh(token)
    ↓
CodexAgent._refreshModels(token)  [VS Code core — calls CAPI directly, NO app-server]
    → this._copilotApiService.models(token, { suppressIntegrationId: true })
      ← CAPI responds with model catalog
    → filters to models with /responses in supported_endpoints
    → this._models.set(filteredModels)
    → AgentHostLanguageModelProvider observes _models, publishes to languageModelsService
    // ← codex models now appear in the picker. App-server still NOT spawned.
```

**The codex app-server is NOT started during initialization.** `CodexAgent._connection` stays `{ kind: 'idle' }` until the first session needs to be materialized.

### When the app-server actually spawns

The app-server is spawned lazily by `_ensureConnection()`, which is called from `_materialize()` when a session's first turn is about to start:

```
User opens a Codex session → createSession() called
    → IAgentCreateSessionResult { provisional: true }  ← session is a placeholder only
    // app-server still NOT spawned

User types first message → sendMessage() called
    → _materialize(session)
        → _ensureConnection()   ← FIRST CALL
            → _startConnection(token)
                → agentSdkDownloader.loadSdkRoot(CodexSdkPackage, token)
                  (resolves sdkRoot from setting / product config)
                → codexProxyService.start(token)
                  → proxyHandle = { nonce: uuid, baseUrl: 'http://localhost:N' }
                → spawn(binaryPath, ['app-server', '-c', 'model_provider=vscode-proxy', ...])
                  ← codex app-server child process starts, JSON-RPC over stdio
                → client.request('initialize', { capabilities: { experimentalApi: true } })
                → client.notify('initialized', ...)
                → _connection = { kind: 'ready', client, proxyHandle, child }
        → conn.client.request('thread/start', { cwd, model, approvalPolicy, dynamicTools })
          ← threadId returned
```

**Summary of what starts when:**

| Step | When | What happens |
|---|---|---|
| Agent-host process starts | VS Code startup | `agentHostMain.ts` evaluates gate |
| `CodexAgent` constructed | VS Code startup (if gate passes) | No subprocess, no network |
| Models fetched | After `authenticate()` (Copilot token arrives) | CAPI call only — no app-server |
| **`codex app-server` spawned** | **First `sendMessage()` call** | `_ensureConnection()` → `spawn(binaryPath, ['app-server', ...])` |
| `thread/start` RPC | Same `sendMessage()`, after spawn | Allocates a thread in the app-server |
| `turn/start` RPC | Same `sendMessage()`, after thread/start | Sends the user's message |

### First chat request

```
User selects Codex in chat session picker (Insiders only)
    ↓
VS Code creates session: type = 'agent-host-openai-codex'
    ↓
chatSessionsService.getChatSessionContentProvider('agent-host-openai-codex')
    → AgentHostSessionHandler.provideChatSessionContent()
    → Returns model list, empty history
    ↓
User types first message
    ↓
AgentHostSessionHandler.handleRequest(request, context, stream, token)
    ↓
CodexAgent.sendMessage(prompt, attachments, model, token)
    ↓
CodexAgent._ensureAuthenticated()
    → IAuthenticationService.getSession('github') → GitHub token
    → Returns Copilot token
    ↓
CodexAgent._refreshModels() [first time]
    → copilotApiService.models(token) → model catalog from CAPI
    → Filters to /responses-capable models
    ↓
CodexAgent lazy materialization: _materializeSession()
    → codexAppServerClient.initialize({ capabilities: { experimentalApi: true } })
    → codexAppServerClient.thread/start({
        model: selectedModelId,
        cwd: workspaceRoot,
        approvalPolicy: 'on-request' | 'never',
        ...
    })
    → threadId stored in codexSessionMetadataStore (durable)
    ↓
codexAppServerClient.turn/start({
    threadId: threadId,
    input: [{ type: 'text', text: userPrompt }]
})
    ↓
Codex SDK (child process) receives request
    → Makes HTTP request to localhost:<proxy_port>
    → Bearer: <nonce>
    ↓
CodexProxyService validates nonce
    → Fetches current Copilot token from IAuthenticationService
    → Forwards to CAPI: api.github.com/copilot/responses
    → With model: selectedModelId
    ↓
CAPI streams response chunks
    ↓
CodexProxyService streams back to SDK child process
    ↓
SDK emits ResponseItems (message, function_call, reasoning, etc.)
    ↓
codexMapAppServerEvents.ts converts to VS Code stream parts
    → 'message' → stream.markdown()
    → 'function_call' → stream.toolCall() or handled directly
    → 'reasoning' → stream.markdown() with thinking marker
    ↓
VS Code Chat UI renders response in real-time
    ↓
On turn completion:
    → codexSessionMetadataStore persists: { threadId, lastTurnId, model }
    → Thread state: active (ready for next turn)
```

### Approval handling

See **§4.7** for the full code-based breakdown. Summary:

- The Codex app server decides whether to request approval based on `CodexSessionConfigKey.ApprovalPolicy` (`'never' | 'on-request' | 'on-failure' | 'untrusted'`), sent in every `TurnStartParams`.
- When approval is needed, the app server sends `commandExecution/requestApproval` (or `fileChange/requestApproval` / `permissions/requestApproval`) JSON-RPC to VS Code.
- `codexAgent._handleCommandApprovalRequest()` fires `ChatToolCallReady` and parks on a deferred.
- User clicks Allow/Deny → `ChatToolCallConfirmed` action → `agentSideEffects` → `respondToPermissionRequest()` → deferred resolves → JSON-RPC returns `'accept' | 'decline' | 'acceptForSession'` to the app server.
- The VS Code "Set permission" picker (`'default' | 'autoApprove' | 'autopilot'`) does **not** affect Codex native tool approvals — it only affects MCP tools going through the generic `_handleToolReady()` path.

---

## 8. Comparison: Codex vs Background-Agent (CLI) Delegation

Both paths use the `chatSessions` extension point architecture but differ significantly in execution model:

| Dimension | Agent-Host Codex (Path B) | Background-Agent CLI (`copilotcli`) |
|---|---|---|
| **Session type** | `agent-host-openai-codex` | `copilotcli` |
| **SDK** | `@openai/codex` (downloaded via `agentSdks.codex`) | `@github/copilot` SDK |
| **Process model** | Child process spawned by agent-host | Child process (CLI) or in-process SDK |
| **Session persistence** | `codexSessionMetadataStore` (durable, per session URI) | `~/.copilot/session-state/*.jsonl` (CLI manages) |
| **History storage** | AppServer manages history server-side per thread | CLI SDK manages via JSONL event log |
| **Isolation** | Workspace only (no worktree) | Optional Git worktree isolation |
| **Auth proxy** | CAPI nonce proxy (Copilot token never exposed to SDK) | Direct Copilot token (SDK is Copilot's own code) |
| **Model source** | CAPI catalog filtered to /responses | CAPI catalog (all Copilot models) |
| **Approval handling** | Configurable (`never`/`on-request`/`on-failure`/`untrusted`) | VS Code UI confirmations + auto-approve workspace files |
| **Tool types** | Codex native tools (shell, file, web_search, MCP) | Copilot CLI tools (write, bash, etc.) |
| **Delegation** | Not delegated from normal chat (it is its own session type) | Can be delegated from `@copilotcli` in normal chat |
| **Enable gate** | `product.agentSdks.codex` (absent in OSS/Stable/current Insiders) + `chat.agentHost.codexAgent.enabled=true` opt-in; dev needs `VSCODE_AGENT_HOST_CODEX_SDK_ROOT` env var | `config.github.copilot.chat.backgroundAgent.enabled` (Stable) |

### Key architectural difference

**CLI path** has explicit worktree isolation and a "delegation" UX: user types `@cli` in normal chat, then a background agent window opens. The session has a lifecycle: created → user first prompt → worktree created → execution → auto-commit → apply changes.

**Codex agent-host path** is a direct session type — user opens a Codex session and types directly into it. No delegation ceremony. It's more like a long-lived REPL with VS Code as the UI shell.

---

## 9. Key Design Insights for the Proposal

### From the VS Code Codex investigation

#### Must-have for MVP

**1. Lazy thread materialization**

Do NOT create `@openai/codex` threads when models are enumerated (during `provideLanguageModelChatInformation`). Only materialize at first `provideLanguageModelChatResponse` call. VS Code codexAgent has a prewarm timer that creates a thread `60s` ahead of expected need if a session is open, but the thread is not created at registration time.

```typescript
// ❌ Wrong — creates threads during model listing
async provideLanguageModelChatInformation(...) {
    const thread = await appServer.thread.start(...);
    return [{ id: thread.id, ... }];
}

// ✅ Correct — thread created on first actual request
async provideLanguageModelChatResponse(model, messages, ...) {
    let threadId = await this.getOrCreateThread(conversationId);
    const turn = await appServer.turn.start({ threadId, input: ... });
}
```

**2. Durable thread mapping**

The `conversationId → threadId` map must survive VS Code restarts. Use `vscode.ExtensionContext.globalState` or a JSON file in `globalStorageUri`. VS Code uses `codexSessionMetadataStore` which writes per-session metadata to disk.

**3. Dynamic tools constraint**

Register all tools at `thread/start` in `dynamicTools`. If the tool set changes before the first user turn, restart the thread. After the first user turn, the tool set is frozen for that thread — new tools only take effect in the next thread (new conversation).

**4. Turn ID correlation**

Maintain two maps (as VS Code does in `codexAgent`):
- `hostTurnIdByAppTurnId`: maps AppServer-assigned turn IDs back to VS Code request IDs
- `codexTurnIdByHostTurnId`: maps VS Code request IDs to AppServer turn IDs

These are needed for stream finalization, truncation, and retry paths to work correctly.

**5. Resume state machine**

```
provisional       → thread not yet started (lazy)
materialized      → thread/start sent, threadId known
needsResume       → process restarted, threadId known from storage, needs thread/resume
active            → turn in progress
idle              → last turn complete, ready for next
disposed          → session closed, resources released
```

**6. Approval policy**

Set `approvalPolicy: 'never'` at `thread/start`. Register wrapper VS Code tools (`vscode.lm.registerTool`) for Codex-side capabilities (shell execution, file writes). This keeps VS Code's approval UI as the single approval system and avoids conflict between two approval dialogs.

#### Nice-to-have for Phase 2

**7. Prewarm**

When a Codex session is opened but before the user types, start a speculative `thread/start` with a 60s TTL. If the user sends a message within 60s, claim the prewarmed thread. If not, dispose it. This eliminates cold-start latency.

**8. Process lifecycle hardening**

Mirror VS Code's `codexAppServerClient`:
- Retry with exponential backoff on transient connection failures
- Surface `stderr` from the Codex child process in a VS Code output channel
- Graceful shutdown: send `shutdown` notification, then `SIGTERM`, then `SIGKILL` after timeout
- Detect stale processes (PID file check)

**9. Optional model catalog overlay**

If deploying in an enterprise environment where Copilot policy applies, add an optional overlay that intersects `model/list` results with the Copilot catalog. For standalone deployment, `model/list` alone is sufficient.

---

## Appendix A — Key Source Files

### VS Code Core — Agent-Host Codex

| File | Purpose |
|---|---|
| `src/vs/platform/agentHost/node/agentHostMain.ts` | Enable gate, provider registration |
| `src/vs/platform/agentHost/node/codex/codexAgent.ts` | Main CodexAgent class, session lifecycle, prewarm |
| `src/vs/platform/agentHost/node/codex/codexAppServerClient.ts` | JSON-RPC client to AppServer process |
| `src/vs/platform/agentHost/node/codex/codexProxyService.ts` | CAPI nonce proxy for authentication |
| `src/vs/platform/agentHost/node/codex/codexSessionMetadataStore.ts` | Durable `threadId` persistence |
| `src/vs/platform/agentHost/node/codex/codexMapAppServerEvents.ts` | ResponseItem → VS Code stream part conversion |
| `src/vs/platform/agentHost/node/codex/codexReplayMapper.ts` | `thread/read` history reconstruction |
| `src/vs/platform/agentHost/node/agentSdkDownloader.ts` | On-demand SDK download from `product.agentSdks.codex` |

### VS Code Core — Session Type Registry

| File | Purpose |
|---|---|
| `src/vs/workbench/contrib/chat/common/chatSessionsService.ts:304` | `SessionType.Codex = 'openai-codex'` constant |
| `src/vs/workbench/contrib/chat/browser/chatSessions/chatSessions.contribution.ts:58` | `chatSessions` extension point registration |
| `src/vs/workbench/contrib/chat/common/sessionTypeAvailability.ts` | `getSessionTypeAvailability` logic |
| `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostChatContribution.ts:301` | Agent-host provider registration |
| `src/vs/workbench/api/browser/viewsExtensionPoint.ts:459` | `chatSessionsProvider` proposed API gate |

### VS Code Core — Background Agent (CLI, for comparison)

| File | Purpose |
|---|---|
| `extensions/copilot/src/extension/chatSessions/copilotcli/node/copilotcliSessionService.ts` | Session wrapper management |
| `extensions/copilot/src/extension/chatSessions/copilotcli/node/copilotcliSession.ts` | SDK session wrapper |
| `extensions/copilot/package.json:6710` | `chatSessions` contribution (`copilotcli`, `claude-code`, `copilot-cloud-agent`) |

---

## Appendix B — Official CodexAppServer Verification Summary

All critical questions have been verified against the official README at `https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md`:

| Question | Answer | Impact |
|---|---|---|
| Is there a `model/list` API? | ✅ Yes, `model/list` with `includeHidden` flag | Can enumerate models at runtime |
| Is history maintained server-side? | ✅ Yes, per thread, full history | Only send new turns, not full history |
| Is `approvalPolicy: "never"` supported? | ✅ Fully documented in examples | Set always; delegate approval to VS Code tools |
| Can thread history be resumed after restart? | ✅ `thread/resume` + `thread/turns/list` for paging | Implement resume state machine with durable threadId |
| Are custom client tools (`item/tool/call`) supported? | ✅ Full RPC request/response documented | Implement wrapper tool routing |
| Are skills/hooks available? | ✅ Via `experimentalApi: true` in initialize | Defer to Phase 2; flag in initialize from day one |
