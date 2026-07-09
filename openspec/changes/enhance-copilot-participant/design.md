## Context

The `copilotcli.participant` (`src/copilotParticipant.ts`) bridges VS Code Chat to the GitHub Copilot CLI via `@github/copilot-sdk@1.0.4`. The SDK spawns the `@github/copilot` runtime as a subprocess over stdio JSON-RPC. Authentication is a GitHub Copilot token passed directly as `CopilotClientOptions.gitHubToken`. The current prototype does **no** model-request proxying — every model call goes to CAPI with that token. Adding a proxy layer so the runtime can also reach VS Code LM models (including third-party models VS Code exposes) is the headline of this change (see Decision 1). (By contrast, the sibling Claude/Codex participants already run a localhost model-translation proxy in `src/proxy/*` that maps their SDKs' API calls onto VS Code's Language Model API; this change reuses those translators.)

The current implementation is a single-file prototype: one shared `CopilotClient`, no per-session state, a permission handler closure recreated per request, only two event subscriptions (`assistant.message_delta`, `session.idle`), no attachment forwarding, no mode selection, and cancellation that only rejects the local completion promise without aborting the subprocess.

Two mature references exist:
- **VS Code agent-host** (`src/vs/platform/agentHost/node/copilot/copilotAgent.ts` + `copilotAgentSession.ts`, ~5,800 lines): the canonical, production SDK usage — session map, `_sessionSequencer`, `_handlePermissionRequest()` tiered cascade, `_resolveSdkMode()`, `mapSessionEvents.ts`, `applyMode()` via `rpc.mode.set`, token-rotation restart, and `_pendingPermissions` deferred map.
- **Sibling participants** (`codexParticipant.ts` at 961 lines, `claudeParticipant.ts` + `src/claude/*`): prove the multi-file decomposition pattern (`*MessageRouter.ts`, `*OptionsBuilder.ts`, `clientToolMcpServer.ts`) that keeps the participant class thin.

Verified SDK surface (`@github/copilot-sdk@1.0.4`):
- `client.createSession(SessionConfig)` / `client.resumeSession(id, ResumeSessionConfig)` → `CopilotSession`.
- `session.send(prompt | MessageOptions)`, `session.abort()`, `session.setModel(id, opts)`, `session.on(eventType, handler)`, `session.rpc.mode.set({ mode })`, `session.rpc.history.compact()`.
- `SessionMode = "interactive" | "plan" | "autopilot"`.
- Callbacks on config: `onPermissionRequest`, `onExitPlanModeRequest`, `onUserInputRequest`, `onElicitationRequest`.
- `PermissionRequest` union: `Shell | Write | Read | Mcp | Url | Memory | CustomTool | Hook | ExtensionManagement | ExtensionPermissionAccess`; result `{ kind: 'approve-once' | 'reject' | ... }`.
- `Attachment` union: `AttachmentFile | AttachmentDirectory | AttachmentSelection | AttachmentGitHubReference | AttachmentBlob | AttachmentExtensionContext`.
- ~80 `SessionEvent` types including `assistant.reasoning`, `assistant.reasoning_delta`, `assistant.streaming_delta`, `assistant.message`, `assistant.message_delta`, `assistant.usage`, `tool.execution_start`, `tool.execution_partial_result`, `tool.execution_complete`, `skill.invoked`, `subagent.started`, `session.idle`, `session.usage_info`, `permission.requested`, `exit_plan_mode.requested`, `compaction.start`/`compaction.complete`.

Verified SDK proxy surface (the differentiator vs. the built-in host agent):
- **Runtime env override** (chosen): the runtime honors `COPILOT_API_URL` + `GITHUB_COPILOT_API_TOKEN` (rpc.d.ts: *"Direct Copilot API authentication via the GITHUB_COPILOT_API_TOKEN + COPILOT_API_URL environment-variable pair"*) and `COPILOT_CLI_DISABLE_WEBSOCKET_RESPONSES` to force HTTP. Setting these at client spawn redirects the runtime's model calls to a localhost proxy — the same env-injection pattern Claude/Codex use.
- `CopilotClientOptions.requestHandler?: CopilotRequestHandler` — an in-process (`@experimental`) base class that can observe/mutate outbound model requests over HTTP + WebSocket. Not used here (would need a Fetch-signature translator refactor); kept as a possible future refinement.
- Existing local infra: `src/proxy/proxyServer.ts` (nonce-authenticated localhost HTTP), `src/proxy/responsesProxy.ts` (OpenAI Responses ⇄ VS Code LM), `src/proxy/messagesProxy.ts` (Anthropic Messages ⇄ VS Code LM) — already shared with Claude/Codex; `responsesProxy` selects the LM by request body id (`vscode.lm.selectChatModels({ id })`).
- Model is per-session dynamic via `createSession({ model })` / `session.setModel(id)` — so one warm subprocess serves many conversations, each with its own picked model. (The documented env-BYOK `COPILOT_MODEL` path is static per subprocess and is therefore NOT used.)

## Goals / Non-Goals

**Goals:**
- **Model proxy**: let the Copilot runtime reach any model VS Code's Language Model API exposes (including third-party models the user has configured in VS Code) by redirecting its Copilot-API endpoint via runtime env (`COPILOT_API_URL`) to the existing localhost `responsesProxy`. Model selection uses the standard chat model picker, passed per session — same as Claude/Codex.
- Per-session state map + turn sequencer so concurrent conversations and rapid sends never race.
- Tiered permission auto-approval with a deferred-promise fallback registry keyed by tool-call id.
- SDK mode translation (`interactive`/`plan`/`autopilot`) driven by VS Code session config, with plan-mode exit handling.
- Full session-event routing (assistant text, reasoning/thinking, tool lifecycle, skills, subagents, usage).
- Slash-command handling for `/compact` and `/plan`.
- GitHub token rotation handling + `rt=` restricted-telemetry gate.
- VS Code attachment → SDK `Attachment` conversion.
- `session.abort()` on cancellation; clean dispose that settles pending deferreds and stops the client.
- Enriched `TurnMetadata` (sessionId, tokenUsage, modelId).

**Non-Goals:**
- SDK-backed model listing (`client.listModels()`) and any custom model picker — deferred (gap item 10); model selection uses the standard VS Code chat model picker.
- SDK-native BYOK provider config (`SessionConfig.provider`/`providers`/`models`, `NamedProviderConfig`, `getBearerToken`) — unnecessary; third-party models are reached through VS Code's LM API, not per-provider config in this extension.
- Git worktree isolation and provisional→live session materialization — remain agent-host-only (Phase 2).
- Sandbox engine / MXC shell sandboxing — agent-host concern, not a participant surface.
- MCP server configuration UI and dynamic client-tool MCP server — deferred (the SDK's `enableConfigDiscovery` can auto-load workspace MCP without new settings).
- Replacing the direct-token auth model — CAPI (proxy-disabled) still uses the direct token; the proxy only takes over when it is enabled and routes to VS Code LM.

## Decisions

### Decision 1: Model proxy via runtime env override → localhost proxy → VS Code LM (the differentiator)

**Choice**: When `copilotcli.modelProxy.enabled`, spawn the `CopilotClient` with env that redirects the runtime's Copilot API endpoint to the existing localhost proxy:
- `COPILOT_API_URL` → `proxyInfo.responsesUrl`
- `GITHUB_COPILOT_API_TOKEN` → `proxyInfo.responsesNonce`
- `COPILOT_CLI_DISABLE_WEBSOCKET_RESPONSES = 'true'` (force HTTP so no WebSocket handling is needed)

The existing `responsesProxy` translates the runtime's OpenAI-Responses calls to VS Code's LM API, selecting the model by request body id. The user's picked model flows per session via `createSession({ model: request.model.id })`. When disabled (default), no env override is set and the runtime uses CAPI with the direct GitHub token — identical to the built-in agent.

**Rationale**:
- This is the exact env-injection pattern the Claude/Codex participants already use, so it's proven and consistent.
- Reuses the existing localhost `ProxyServer` + `responsesProxy` **as-is** — no Fetch/`requestHandler` adaptation, no translator refactor.
- `COPILOT_CLI_DISABLE_WEBSOCKET_RESPONSES` forces the HTTP transport, eliminating any need to intercept WebSocket traffic.
- Model is **per-session dynamic** over one warm subprocess (1 subprocess → N sessions), so different conversations can pick different models.

**Alternatives considered**:
- **In-process `CopilotRequestHandler`**: `@experimental`, covers HTTP+WebSocket in-process, but needs the Node-http translators adapted to the Fetch `Request`/`Response` signature. Deferred as a future refinement.
- **env-BYOK (`COPILOT_PROVIDER_BASE_URL` + `COPILOT_MODEL`)**: documented BYOK path, but `COPILOT_MODEL` is static per subprocess; with 1 subprocess → N sessions it would pin every conversation to one model. Rejected.
- **SDK-native BYOK registry** (`SessionConfig.providers`/`models` + `setModel('provider/id')`): dynamic per session and reaches third-party directly, but re-introduces per-provider key management this extension avoids by routing through VS Code LM.

**Security**: inference stays on the VS Code LM path; the proxy is nonce-authenticated on 127.0.0.1; this extension stores no third-party keys (VS Code's LM providers own them).

### Decision 2: Multi-session state map + turn sequencer

**Choice**: Store `Map<string, CopilotSessionEntry>` keyed by SDK session id. Each entry holds the `CopilotSession`, its `RouterState`, its `_pendingPermissions` map, and a single-slot promise chain (`sequencer`) that serializes turns per session.

**Rationale**: The host uses `_sessions` + `_sessionSequencer.queue(sessionId, ...)`. Without it, a second `send()` before `session.idle` produces overlapping turns on one SDK session, and permission responses route to the wrong deferred. Session id is discovered from `ChatResult.metadata` on resume (existing `findSessionIdInHistory` helper).

### Decision 3: Tiered permission approval with deferred registry

**Choice**: Port the host's `_handlePermissionRequest()` cascade. Order:
1. Session-internal resource path → `approve-once`.
2. `kind === 'read'` on a user-attached path → `approve-once`.
3. `kind === 'read'` on an SDK temp file → `approve-once`.
4. `kind === 'custom-tool'` non-confirmation tool → `approve-once`.
5. Otherwise: park a `DeferredPromise<boolean>` in the per-session registry keyed by `toolCallId`, render a confirmation via `vscode_get_confirmation` (as today) — but resolved through the registry so multiple concurrent requests and cross-turn responses work.

**Rationale**: The current closure cannot correlate a late user response to the right request and re-creates handlers per request. A registry keyed by `toolCallId` (like `src/util/pendingRequestRegistry.ts`, already used by Codex) fixes correlation and enables auto-approval to skip the dialog for safe operations.

**Alternatives considered**: Keep the per-request closure — rejected: cannot handle concurrent permission requests or dispose-time cleanup.

### Decision 4: Agent mode per turn via slash commands + `onExitPlanModeRequest`

**Choice**: A chat participant has no agent-host `(mode, autoApprove)` session-config surface, and no portable proposed API for it (`ChatRequest.permissionLevel` exists only in the **restricted** `chatParticipantPrivate` proposal — values `autoApprove`/`autopilot`, no `plan` — and there is no participant-facing thinking-effort pick). So the participant resolves the per-turn SDK `agentMode` from a leading slash command and applies it via `MessageOptions.agentMode` on `send()`:

| Slash command | `agentMode` | Behaviour |
|---|---|---|
| `/plan` | `plan` | Propose a plan; no execution. `onExitPlanModeRequest` prompts before executing. |
| `/autopilot` | `autopilot` | Execute without approval prompts (SDK stops calling `onPermissionRequest`). |
| (none) | `interactive` | Execute; approvals go through `CopilotPermissionHandler`. |

**Rationale**:
- `MessageOptions.agentMode` is a per-turn field — a natural fit for the per-turn participant, simpler than `session.rpc.mode.set` + a `_lastAppliedMode` guard.
- Slash commands are consistent with `/compact` and discoverable in the chat `/` menu; they need no fake session-config surface.
- `onExitPlanModeRequest` (first-class in SDK 1.0.4) handles the plan→execute transition.
- The restricted `chatParticipantPrivate.permissionLevel` is not portable to a third-party participant, so it is not used (could be a dev-only progressive enhancement for `autopilot`).

### Decision 5: Full event routing via a pure router

**Choice**: `routeSessionEvent(event, stream, state)` switches on `event.type` and maps to stream actions:

| SDK event | Stream action |
|---|---|
| `assistant.reasoning` / `assistant.reasoning_delta` | `stream.thinkingProgress()` |
| `assistant.message` / `assistant.message_delta` | `stream.markdown()` |
| `tool.execution_start` | `stream.progress()` (tool badge open) |
| `tool.execution_partial_result` | streamed tool output |
| `tool.execution_complete` | badge close |
| `skill.invoked` | `stream.markdown()` annotation |
| `subagent.started` | `stream.progress()` delegation indicator |
| `assistant.usage` / `session.usage_info` | accumulate into `RouterState.tokenUsage` |
| `session.idle` | resolve the turn completion promise |

**Rationale**: The host's `mapSessionEvents.ts` proves the mapping. A pure function keeps it testable. Unknown event types are ignored (forward-compatible with the ~80-event union).

### Decision 6: Attachment conversion

**Choice**: `toSdkAttachments(request)` maps VS Code `ChatPromptReference`/attachment values to SDK `Attachment`:
- File URI → `AttachmentFile { type: 'file', path }` (with line range → `AttachmentFileLineRange` when present).
- Editor selection → `AttachmentSelection`.
- Image → `AttachmentBlob`.
Pass the resulting array via `session.send({ prompt, attachments })`.

**Rationale**: `send()` accepts `MessageOptions` with `attachments`; today the participant only sends `{ prompt }`, silently dropping context. Directory/GitHub-reference/extension-context attachment kinds are mapped best-effort or skipped.

### Decision 7: Cancellation via `session.abort()`

**Choice**: On `token.onCancellationRequested`, call `session.abort()` (awaited best-effort) before rejecting the local completion promise.

**Rationale**: The current code leaves the subprocess running after cancel. `session.abort()` is the SDK-native stop, analogous to Claude's `AbortController.abort()` and Codex's `turn/interrupt`.

### Decision 8: Token rotation + restricted-telemetry gate

**Choice**: Track the last-seen GitHub token. When a new request presents a changed token: if no sessions are active, `client.stop()` and recreate on next use; parse the token header `rt=` field — when `rt === '1'`, enable restricted telemetry. Reuse the host's `parseCopilotTokenFields()` logic (small, portable).

**Rationale**: Copilot tokens rotate periodically; the current client would silently fail on a stale token. The `rt=` gate mirrors `copilotTokenFields.ts` in the host.

## Risks / Trade-offs

- **Event volume**: enabling reasoning/tool streaming multiplies event throughput. Mitigation: router is O(1) per event; deltas are small.
- **Client restart on token rotation**: restarting the subprocess mid-conversation would drop state, so restart only happens when no session is active; otherwise the existing session keeps its (still-valid-until-expiry) token.
- **Permission correlation**: a malformed request without `toolCallId` must default to `reject` (fail-safe), matching the host.
- **Scope creep**: MCP/dynamic-tools and the CAPI model picker are explicitly deferred to keep this change focused on parity fundamentals plus the model-proxy differentiator.

## Migration Plan

Incremental, backward-compatible (session ids from prior turns still resume):
1. Land the `src/copilot/*` pure-function modules with unit tests (event router, attachment conversion, provider-config builder).
2. Enable the model proxy by injecting `COPILOT_API_URL` / `GITHUB_COPILOT_API_TOKEN` / `COPILOT_CLI_DISABLE_WEBSOCKET_RESPONSES` env at client spawn (behind `copilotcli.modelProxy.enabled`), reusing the existing localhost `responsesProxy`; pass the picked model per session. Keep CAPI pass-through as the default so behavior is unchanged when disabled.
3. Introduce the session map + sequencer in `CopilotParticipant`, keeping current behavior for a single session.
4. Swap in the tiered permission handler + deferred registry.
5. Wire mode translation and `onExitPlanModeRequest`.
6. Expand event subscriptions to the full router; add thinking/tool/usage.
7. Add slash commands, attachment forwarding, cancellation abort, token rotation, and dispose cleanup.

## Open Questions

- Does `vscode_get_confirmation` expose a stable tool-call correlation id, or should the participant generate one per `PermissionRequest`? (Assume participant-generated id keyed to the SDK `toolCallId`.)
- Should `/compact` output a visible summary line, or complete silently? (Assume a short `stream.markdown()` confirmation, matching the host.)
