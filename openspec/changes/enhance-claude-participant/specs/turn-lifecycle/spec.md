## ADDED Requirements

### Requirement: Turn start signal
The system SHALL emit a turn start signal when a Claude query begins.

#### Scenario: Start progress on query
- **WHEN** `handleRequest()` begins processing a user message
- **THEN** the participant SHALL call `stream.progress()` with "Starting Claude session…" (new) or "Resuming Claude session…" (existing)

### Requirement: Turn completion signal
The system SHALL emit a turn completion signal when a Claude query finishes.

#### Scenario: Complete on result message
- **WHEN** the SDK yields a `result` message with `type: 'success'`
- **THEN** the participant SHALL mark the turn as complete
- **THEN** the participant SHALL return `{ metadata: { sessionId } }`

#### Scenario: Complete on error
- **WHEN** the SDK yields a `result` message with `type: 'error'` or throws an exception
- **THEN** the participant SHALL display an error message in the chat stream
- **THEN** the participant SHALL return without metadata to avoid reusing a broken session

### Requirement: Turn cancellation
The system SHALL cancel an in-flight Claude query when the user cancels the request.

#### Scenario: Cancel via AbortController
- **WHEN** the VS Code cancellation token fires
- **THEN** the participant SHALL call `abortController.abort()`
- **THEN** the SDK SHALL stop the current query and clean up the subprocess

### Requirement: Token usage tracking
The system SHALL extract and log token usage from SDK result messages.

#### Scenario: Log usage from result message
- **WHEN** the SDK yields a `result` message containing `message.usage` with `input_tokens`, `output_tokens`, and `cache_creation_input_tokens` / `cache_read_input_tokens`
- **THEN** the participant SHALL log the token usage to the console
- **THEN** the participant SHALL include usage data in the turn result metadata

#### Scenario: Log usage from message_delta
- **WHEN** the SDK yields `stream_event` with `message_delta` containing `usage`
- **THEN** the participant SHALL log the cumulative token usage to the console
