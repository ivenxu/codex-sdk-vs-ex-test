## Why

The `copilotcli.participant` chat participant (`src/copilotParticipant.ts`, ~216 lines) is an early prototype. It bridges VS Code Chat to the GitHub Copilot CLI SDK (`@github/copilot-sdk@1.0.4`) but implements only a thin slice of the SDK's surface: it handles exactly **2 of ~80 session event types** (`assistant.message_delta`, `session.idle`), always prompts the user for every permission, never sets an agent mode, discards attachments, and cannot cancel an in-flight turn. The VS Code agent-host (`copilotAgent.ts` / `copilotAgentSession.ts`, ~5,800 lines combined) and the sibling `codexParticipant.ts` (961 lines) / `claudeParticipant.ts` + `src/claude/*` modules prove the full feature set is achievable. This change closes the gaps identified in the exhaustive gap analysis so Copilot CLI reaches parity with the Codex and Claude participants.

**The headline capability is model proxying — the single biggest differentiator from the built-in host-agent Copilot.** The built-in agent passes the GitHub Copilot token straight to the runtime and can therefore only ever use CAPI (Copilot-hosted) models. Because this participant owns the client, it can insert a proxy layer between the Copilot runtime and its model backend and route model calls through VS Code's own Language Model API — unlocking **any model VS Code exposes, including third-party models** the user has configured in VS Code. Model selection uses the standard chat model picker and third-party models need no special handling — it works exactly like the Claude and Codex participants, reusing the same proxy-translation infrastructure (`src/proxy/*`). This turns Copilot CLI from a Copilot-only agent into a model-agnostic agent harness.

## What Changes

- **Model proxy (headline)**: Insert a model-layer proxy so the Copilot runtime's model calls are served by VS Code's Language Model API instead of CAPI. Behind `copilotcli.modelProxy.enabled`, spawn the runtime with env (`COPILOT_API_URL`, `GITHUB_COPILOT_API_TOKEN`, `COPILOT_CLI_DISABLE_WEBSOCKET_RESPONSES`) that redirects its Copilot-API endpoint to the existing localhost `responsesProxy` — the same env-injection pattern Claude/Codex use. The model is chosen with the standard VS Code chat model picker and passed per session via `createSession({ model })`; third-party models are simply whatever VS Code exposes and need no special handling. CAPI (direct token) pass-through remains the default when the proxy is disabled.
- **Multi-session state**: Replace the single shared `_client`/session with a `Map<string, CopilotAgentSession>` keyed by SDK session id, plus a per-session turn sequencer so concurrent conversations and rapid successive messages cannot race.
- **Tiered permission approval**: Replace the one-shot per-request permission closure with a tiered auto-approval cascade (attached-file reads, SDK temp files) that falls back to a `DeferredPromise` registry keyed by tool-call id, mirroring the host's `_handlePermissionRequest()`.
- **Agent mode (per turn)**: Resolve the SDK `agentMode` (`interactive` | `plan` | `autopilot`) from a leading slash command and apply it via `MessageOptions.agentMode` on `send()`; wire `onExitPlanModeRequest` for the plan→execute transition. (A chat participant has no agent-host `(mode, autoApprove)` session-config surface.)
- **Full event routing**: Extract a `routeSessionEvent()` module that handles the full SDK event surface — `assistant.reasoning`/`assistant.reasoning_delta` (thinking), `assistant.message`/`assistant.message_delta`, `tool.execution_start`/`partial_result`/`complete`, `skill.invoked`, `subagent.started`, `assistant.usage`/`session.usage_info` — mapping each to the appropriate `stream` action.
- **Reasoning/thinking display**: Surface `assistant.reasoning*` events via `stream.thinkingProgress()`.
- **Slash commands**: Parse leading slash commands — `/compact` (calls history compaction and completes the turn), `/plan` (plan mode for the turn), and `/autopilot` (auto-approving mode).
- **Token refresh + telemetry gate**: Detect GitHub token rotation, restart the client when idle, and parse the token `rt=` field to gate restricted telemetry.
- **Attachment conversion**: Convert VS Code chat attachments (`#file:`, selection, image) to SDK `Attachment` objects and pass them via `session.send({ prompt, attachments })`.
- **Cancellation**: Call `session.abort()` on cancellation instead of only rejecting the local promise, so the subprocess stops work.
- **Lifecycle cleanup**: On dispose, reject all pending permission deferreds and call `client.stop()`; enrich `TurnMetadata` with token usage and model id.

## Capabilities

### New Capabilities
- `model-proxy`: Model-layer proxy that routes the Copilot runtime's outbound model requests through VS Code's Language Model API, so any model VS Code exposes (including third-party models) can back the runtime, selected via the standard chat model picker. **(Primary differentiator.)**
- `session-lifecycle`: Multi-session state map, per-session turn sequencer, dispose cleanup, and enriched turn metadata (token usage, model id).
- `permission-approval`: Tiered auto-approval cascade with a deferred-promise registry keyed by tool-call id for user-confirmation fallback.
- `sdk-mode-translation`: Per-turn SDK `agentMode` (`interactive`/`plan`/`autopilot`) chosen via slash commands, with plan-mode exit handling.
- `event-streaming`: Full SDK session-event router covering assistant text, reasoning/thinking, tool lifecycle, skills, subagents, and usage.
- `slash-commands`: Leading slash-command parsing for `/compact`, `/plan`, and `/autopilot`.
- `token-authentication`: GitHub token rotation handling and `rt=` restricted-telemetry gating.
- `attachment-conversion`: VS Code chat attachment → SDK `Attachment` conversion passed into `session.send`.
- `turn-cancellation`: `session.abort()` on cancellation for in-flight turn termination.

### Modified Capabilities
- *(No existing specs to modify — the current participant has no committed specs.)*

## Impact

- **`src/copilotParticipant.ts`**: Major rewrite — thin orchestrator delegating to new modules; grows from ~216 to ~450 lines.
- **New files** (mirroring `src/claude/*` decomposition):
  - `src/copilot/copilotSessionEventRouter.ts` — pure `routeSessionEvent(event, stream, state)` mapping SDK events to stream actions.
  - `src/copilot/copilotPermissionHandler.ts` — tiered auto-approval + deferred registry (reuses `src/util/pendingRequestRegistry.ts`).
  - `src/copilot/copilotAttachments.ts` — VS Code attachment → SDK `Attachment` conversion.
  - `src/copilot/copilotTokenFields.ts` — `parseCopilotTokenFields()` + `rt=` telemetry gate.
- **Model proxy**: no new module — the participant injects `COPILOT_API_URL`/token env at client spawn (behind `copilotcli.modelProxy.enabled`) and reuses the existing localhost `ProxyManager` / `responsesProxy` as-is.
- **`package.json`**: No new dependencies (`@github/copilot-sdk@1.0.4` already installed; proxy uses the existing servers). One new setting `copilotcli.modelProxy.enabled`.
- **`extension.ts`**: pass the shared `ProxyManager` into `CopilotParticipant`.
- **Out of scope**: SDK-backed model listing (`client.listModels()`) and any custom model picker — deferred; SDK-native BYOK provider config is intentionally not used (third-party models are reached through VS Code LM); Git worktree isolation and provisional-session materialization remain agent-host-only (Phase 2).
