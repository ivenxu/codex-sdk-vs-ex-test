## ADDED Requirements

### Requirement: Full session-event routing
The participant SHALL route the full set of Copilot SDK session events through a single dispatcher and ignore unknown event types.

#### Scenario: Unknown events are ignored
- **WHEN** the SDK emits an event type the participant does not handle
- **THEN** the participant SHALL ignore it without error

### Requirement: Assistant text streaming
The participant SHALL stream assistant text to the chat response.

#### Scenario: Streamed assistant deltas
- **WHEN** the SDK emits `assistant.message` or `assistant.message_delta`
- **THEN** the participant SHALL render the text via `stream.markdown()`

### Requirement: Reasoning/thinking display
The participant SHALL display the model's reasoning content in the thinking progress UI.

#### Scenario: Reasoning start and deltas
- **WHEN** the SDK emits `assistant.reasoning` followed by `assistant.reasoning_delta` events
- **THEN** the participant SHALL forward the reasoning text via `stream.thinkingProgress()`

### Requirement: Tool call lifecycle
The participant SHALL reflect tool execution progress in the chat response.

#### Scenario: Tool start, output, and completion
- **WHEN** the SDK emits `tool.execution_start`, then `tool.execution_partial_result`, then `tool.execution_complete`
- **THEN** the participant SHALL show tool progress on start, stream partial output, and close the tool display on completion

### Requirement: Skill and subagent indicators
The participant SHALL indicate skill invocations and subagent delegations.

#### Scenario: Skill invoked
- **WHEN** the SDK emits `skill.invoked`
- **THEN** the participant SHALL show a skill-usage annotation

#### Scenario: Subagent started
- **WHEN** the SDK emits `subagent.started`
- **THEN** the participant SHALL show a delegation indicator

### Requirement: Token usage accumulation
The participant SHALL accumulate token usage from usage events for inclusion in turn metadata.

#### Scenario: Usage captured
- **WHEN** the SDK emits `assistant.usage` or `session.usage_info`
- **THEN** the participant SHALL accumulate the reported token usage into the router state

### Requirement: Turn completion
The participant SHALL complete a turn when the session becomes idle.

#### Scenario: Idle completes the turn
- **WHEN** the SDK emits `session.idle`
- **THEN** the participant SHALL resolve the turn completion promise
