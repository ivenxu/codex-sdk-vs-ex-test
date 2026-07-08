## ADDED Requirements

### Requirement: Tool call start notification
The system SHALL display a progress notification when Claude begins a tool call.

#### Scenario: Show progress on tool_use start
- **WHEN** the SDK yields `stream_event` with `content_block_start { type: 'tool_use' }` containing tool `name` and `id`
- **THEN** the participant SHALL call `stream.progress()` with the tool name (e.g., "Calling bash…")

### Requirement: Tool input streaming
The system SHALL stream tool call input JSON deltas as they arrive from the SDK.

#### Scenario: Stream input JSON deltas
- **WHEN** the SDK yields `stream_event` with `content_block_delta { type: 'input_json_delta' }` containing partial JSON
- **THEN** the participant SHALL append the delta to the tool call's input display

### Requirement: Tool call completion notification
The system SHALL notify when a tool call completes.

#### Scenario: Complete on content_block_stop
- **WHEN** the SDK yields `stream_event` with `content_block_stop` for a tool_use block
- **THEN** the participant SHALL update progress to indicate completion (e.g., "bash finished")

### Requirement: Tool result display
The system SHALL display tool execution results returned by the SDK.

#### Scenario: Display tool result from user message
- **WHEN** the SDK yields a `user` type message containing a `tool_result` content block
- **THEN** the participant SHALL display the tool result content (output text, error status) in the chat stream

### Requirement: Multiple concurrent tool calls
The system SHALL track multiple tool calls that may overlap or be sequential.

#### Scenario: Sequential tool calls in one turn
- **WHEN** Claude makes multiple sequential tool calls (e.g., bash then edit)
- **THEN** each tool call SHALL show its own lifecycle (start → input streaming → completion)
