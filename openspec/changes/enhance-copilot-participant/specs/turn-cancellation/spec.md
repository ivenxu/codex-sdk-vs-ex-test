## ADDED Requirements

### Requirement: Cancellation aborts the SDK session
The participant SHALL abort the in-flight SDK turn when the request is cancelled, so the subprocess stops working.

#### Scenario: Cancel mid-turn
- **WHEN** the chat request's cancellation token is triggered during an active turn
- **THEN** the participant SHALL call `session.abort()` before rejecting the local completion promise

#### Scenario: No further output after abort
- **WHEN** a turn has been aborted
- **THEN** the participant SHALL stop streaming further assistant output for that turn
