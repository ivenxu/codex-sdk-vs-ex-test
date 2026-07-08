## ADDED Requirements

### Requirement: Thinking content streaming
The system SHALL stream Claude's thinking/reasoning content in real-time to the VS Code chat thinking progress UI.

#### Scenario: Display thinking on content_block_start
- **WHEN** the SDK yields `stream_event` with `content_block_start { type: 'thinking' }`
- **THEN** the participant SHALL call `stream.thinkingProgress()` with a "Thinking…" indicator

#### Scenario: Stream thinking text deltas
- **WHEN** the SDK yields `stream_event` with `content_block_delta { type: 'thinking_delta' }` containing `thinking` text
- **THEN** the participant SHALL call `stream.thinkingProgress()` with the delta text appended

#### Scenario: End thinking on content_block_stop
- **WHEN** the SDK yields `stream_event` with `content_block_stop` for a thinking block
- **THEN** the participant SHALL stop sending thinking progress updates for that block

#### Scenario: Multiple thinking blocks in one turn
- **WHEN** Claude emits multiple thinking blocks in a single turn (e.g., before and after tool calls)
- **THEN** each thinking block SHALL be displayed as a separate thinking progress segment
