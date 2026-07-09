## ADDED Requirements

### Requirement: Per-session state map
The participant SHALL maintain a map of active Copilot SDK sessions keyed by SDK session id, so that concurrent chat conversations do not share or overwrite session state.

#### Scenario: Two conversations run independently
- **WHEN** two VS Code chat conversations each have an active Copilot CLI session
- **THEN** each conversation's session, router state, and pending-permission registry SHALL be isolated in its own map entry

#### Scenario: Resume an existing session
- **WHEN** a request arrives whose history contains a saved `sessionId` in `ChatResult.metadata`
- **THEN** the participant SHALL look up or resume that session instead of creating a new one

#### Scenario: Missing session falls back to create
- **WHEN** a saved `sessionId` cannot be resumed (resume fails)
- **THEN** the participant SHALL create a new session and continue the turn

### Requirement: Per-session turn sequencer
The participant SHALL serialize turns within a single session so that a new message waits for the previous turn to complete.

#### Scenario: Rapid successive messages
- **WHEN** a second message is sent before the current turn emits `session.idle`
- **THEN** the second `send()` SHALL be queued behind the first and dispatched only after the first turn completes

### Requirement: Enriched turn metadata
The participant SHALL return turn metadata containing the session id and, when available, token usage and model id.

#### Scenario: Metadata carries usage
- **WHEN** a turn completes after emitting usage events
- **THEN** the returned `TurnMetadata` SHALL include `sessionId`, `tokenUsage`, and `modelId`

### Requirement: Dispose cleanup
The participant SHALL release all session resources on dispose.

#### Scenario: Dispose settles pending work
- **WHEN** the participant is disposed while permission deferreds are outstanding
- **THEN** each pending deferred SHALL be rejected, the session map SHALL be cleared, and the SDK client SHALL be stopped
