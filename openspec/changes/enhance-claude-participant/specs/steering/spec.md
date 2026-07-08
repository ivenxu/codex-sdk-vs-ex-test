## ADDED Requirements

### Requirement: Mid-turn message injection
The system SHALL support injecting messages into an active Claude turn.

#### Scenario: Inject user message mid-turn
- **WHEN** Claude is in the middle of a turn (e.g., after a tool call but before the final response)
- **THEN** the participant SHALL support injecting a new user message via the `WarmQuery` pipeline
- **THEN** Claude SHALL process the injected message as if it were part of the original conversation

### Requirement: WarmQuery session lifecycle
The system SHALL use `startup()`+`WarmQuery` pattern for sessions that require steering support.

#### Scenario: Start WarmQuery session
- **WHEN** a session is created with steering support enabled
- **THEN** the participant SHALL call `sdk.startup(options)` to create a `WarmQuery`
- **THEN** the `WarmQuery` SHALL be stored for the session's lifetime

#### Scenario: Query through WarmQuery
- **WHEN** the user sends a message in a steering-enabled session
- **THEN** the participant SHALL call `warm.query({ prompt, attachments })` instead of `query({ prompt, options })`
- **THEN** the returned `AsyncIterable<SDKMessage>` SHALL be processed through the standard message router

#### Scenario: Inject steering message
- **WHEN** a steering message needs to be injected during an active `WarmQuery`
- **THEN** the participant SHALL call `warm.query({ prompt: steeringMessage, attachments })` on the same `WarmQuery`
- **THEN** the SDK SHALL inject the message into the active turn context

### Requirement: Session idle timeout
The system SHALL automatically clean up `WarmQuery` sessions after a period of inactivity.

#### Scenario: Dispose idle session
- **WHEN** a `WarmQuery` session has been idle for 30 minutes
- **THEN** the participant SHALL dispose the session
- **THEN** the participant SHALL clean up the SDK subprocess
- **THEN** the next user message SHALL create a fresh session

### Requirement: Graceful degradation
The system SHALL fall back to `query()` API when `startup()`+`WarmQuery` is unavailable or fails.

#### Scenario: Fallback on startup failure
- **WHEN** `sdk.startup()` throws an error
- **THEN** the participant SHALL log the error
- **THEN** the participant SHALL fall back to `query()` for the turn
- **THEN** steering support SHALL be unavailable for that session
