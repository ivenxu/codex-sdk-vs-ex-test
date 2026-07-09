## 1. Foundation: Module Extraction

- [x] 1.1 Create `src/copilot/copilotSessionEventRouter.ts` — pure `routeSessionEvent(event, stream, state): RouterState` with a `RouterState` type (activeThinkingId, tokenUsage, lastAssistantMessageId)
- [ ] 1.2 Create `src/copilot/copilotSessionConfigBuilder.ts` — `buildSessionConfig(request, context, cwd, handlers)` and `buildResumeConfig(...)` returning SDK `SessionConfig`/`ResumeSessionConfig` _(inlined in participant for now; no separate module)_
- [x] 1.3 Create `src/copilot/copilotAttachments.ts` — `toSdkAttachments(request): Attachment[]` mapping VS Code references to SDK attachment kinds
- [x] 1.4 Create `src/copilot/copilotPermissionHandler.ts` — tiered auto-approval + `DeferredPromise` registry (reuse `src/util/pendingRequestRegistry.ts` where possible)
- [x] 1.5 Reduce `CopilotParticipant` to a thin orchestrator that delegates to the modules

## 2. Model Proxy (headline differentiator)

- [x] 2.1 Route the runtime's model calls through the existing localhost proxy by setting the runtime env (`COPILOT_API_URL`, `GITHUB_COPILOT_API_TOKEN`, `COPILOT_CLI_DISABLE_WEBSOCKET_RESPONSES`) at client spawn — the same env-injection pattern Claude/Codex use
- [x] 2.2 Reuse the existing `src/proxy/responsesProxy.ts` server as-is (it already selects the VS Code LM model by request body id via `vscode.lm.selectChatModels({ id })`) — no translator changes needed
- [x] 2.3 Pass the user-picked model per session via `createSession({ model: request.model.id })` so model selection is dynamic per conversation over the single warm subprocess
- [x] 2.4 Gate everything behind `copilotcli.modelProxy.enabled`; keep CAPI (direct token) as the default so behavior is unchanged when disabled
- [x] 2.5 Add setting `copilotcli.modelProxy.enabled` (boolean); model selection uses the standard chat model picker — no per-provider settings
- [x] 2.6 Restart the client when the proxy setting (or token) changes and no sessions are active (env is fixed at spawn)
- [ ] 2.7 Runtime-verify which path/wire format the runtime calls on `COPILOT_API_URL` (add a `/chat/completions` route to the proxy if it is not `/responses`) — requires launching the extension

## 3. Multi-Session State + Turn Sequencer

- [x] 3.1 Add `_sessions: Map<string, CopilotSessionEntry>` keyed by SDK session id; entry holds `CopilotSession`, `RouterState`, per-session pending-permission registry, and a turn `sequencer` promise chain
- [x] 3.2 Serialize turns per session: queue each `send()` behind the session's `sequencer` so a second message waits for `session.idle`
- [x] 3.3 Resume path: read session id via existing `findSessionIdInHistory`, look up or resume into `_sessions`, create fresh entry on miss
- [x] 3.4 Enrich `TurnMetadata` to `{ sessionId, tokenUsage?, modelId? }` and populate from `RouterState` at turn end

## 4. Full Event Routing (Streaming + Thinking + Tools + Usage)

- [x] 4.1 Subscribe to the full event set on session create/resume and dispatch through `routeSessionEvent`
- [x] 4.2 Thinking display: `assistant.reasoning` → open thinking, `assistant.reasoning_delta` → `stream.thinkingProgress()`, end on next assistant message
- [x] 4.3 Assistant text: handle both `assistant.message` and `assistant.message_delta` (open turn + stream deltas)
- [x] 4.4 Tool lifecycle: `tool.execution_start` → `stream.progress()`, `tool.execution_partial_result` → stream output, `tool.execution_complete` → close
- [x] 4.5 Skills & subagents: `skill.invoked` → annotation, `subagent.started` → delegation indicator
- [x] 4.6 Usage: accumulate `assistant.usage` + `session.usage_info` into `RouterState.tokenUsage`
- [x] 4.7 Turn completion: `session.idle` resolves the per-turn completion promise
- [ ] 4.8 Unit-test the router with mock events (reasoning, message_delta, tool.execution_*, usage_info, idle)

## 5. Tiered Permission Approval

- [x] 5.1 Implement the 4-tier auto-approval cascade (session-internal resource, attached-file read, SDK temp-file read, non-confirmation custom-tool) → `approve-once` _(attached-read + temp-read tiers implemented; session-internal and server-tool tiers are agent-host-only and N/A for the participant)_
- [x] 5.2 Fallback: park a `DeferredPromise<boolean>` in the per-session registry keyed by `toolCallId`; reject when `toolCallId` is missing (fail-safe)
- [x] 5.3 Render the confirmation via `vscode_get_confirmation`, resolving the matching deferred with the user decision
- [x] 5.4 Support concurrent permission requests (multiple deferreds outstanding) and cross-turn resolution
- [ ] 5.5 Unit-test the tiered handler: each auto-approve tier, missing-id reject, and deferred resolve/reject

## 6. Agent Mode (per-turn via slash commands)

- [x] 6.1 Resolve the per-turn SDK `agentMode` from a leading slash command: `/plan` → `plan`, `/autopilot` → `autopilot`, default → `interactive` (a chat participant has no agent-host `(mode, autoApprove)` session-config surface, so slash commands are the source of truth)
- [x] 6.2 Apply the mode per turn via `MessageOptions.agentMode` on `session.send()` (simpler and more correct for a per-turn participant than `session.rpc.mode.set`)
- [x] 6.3 Wire `onExitPlanModeRequest` in the session config; surface plan-exit as a `vscode_get_confirmation` dialog
- [x] 6.4 `autopilot` mode suppresses `onPermissionRequest` prompts (the SDK auto-runs) — verified via the agentMode path

## 7. Slash Commands

- [x] 7.1 Add `parseLeadingSlashCommand(prompt)` helper (`/compact`, `/plan`)
- [x] 7.2 `/compact`: call `session.rpc.history.compact()`, emit a short confirmation via `stream.markdown()`, complete the turn without an SDK `send`
- [x] 7.3 `/plan`: force `SessionMode = 'plan'` for the current turn (overriding resolved mode) _(applied via `MessageOptions.agentMode: 'plan'`)_

## 8. Attachments

- [x] 8.1 Map file references (with optional line ranges) → `AttachmentFile`
- [ ] 8.2 Map editor selection → `AttachmentSelection`; map images → `AttachmentBlob` _(selection done; image/blob not yet mapped)_
- [x] 8.3 Pass attachments via `session.send({ prompt, attachments })`; skip unsupported kinds gracefully
- [ ] 8.4 Unit-test `toSdkAttachments` across reference kinds

## 9. Cancellation + Authentication + Lifecycle

- [x] 9.1 On `token.onCancellationRequested`, call `session.abort()` (best-effort await) before rejecting the completion promise
- [x] 9.2 Track the last-seen GitHub token; on change with no active sessions, `client.stop()` and lazily recreate the client
- [x] 9.3 Port `parseCopilotTokenFields()`; gate restricted telemetry on `rt === '1'`
- [x] 9.4 `dispose()`: reject all pending permission deferreds, clear `_sessions`, and `await client.stop()`

## 10. Verification

- [x] 10.1 `npm run compile` (or the workspace build task) passes with no TypeScript errors
- [ ] 10.2 Model-proxy smoke: with `copilotcli.modelProxy.enabled`, confirm a turn is served by the model picked in the chat model picker (including a non-CAPI third-party model that VS Code exposes), and that disabling the proxy falls back to CAPI
- [ ] 10.3 End-to-end smoke: create session, send a prompt with a `#file:` attachment, confirm text + thinking + tool progress render, and a follow-up turn resumes the same session
- [ ] 10.4 Permission smoke: verify auto-approve tiers skip the dialog and a shell request prompts; `autopilot` mode runs without prompts
- [ ] 10.5 Cancellation smoke: cancel mid-turn and confirm the subprocess stops (no further deltas within a few seconds)
