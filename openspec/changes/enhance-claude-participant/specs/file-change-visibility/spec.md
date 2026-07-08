## ADDED Requirements

### Requirement: File edit detection
The system SHALL detect when Claude performs file edits during a turn.

#### Scenario: Detect file edit from tool_use
- **WHEN** the SDK yields a `content_block_start{type:'tool_use'}` with tool name `'Edit'` or `'FileWrite'` or `'file_edit'`
- **THEN** the participant SHALL record that a file edit is in progress
- **THEN** the participant SHALL show a progress notification with the target file path

### Requirement: File change summary display
The system SHALL display a summary of file changes made by Claude in the chat response.

#### Scenario: Display change summary on tool result
- **WHEN** a file-edit tool returns with a successful result
- **THEN** the participant SHALL display: file path, operation type (edit/create/rename/delete), and brief description
- **THEN** the participant SHALL format the summary using stream.markdown()

#### Scenario: Multiple file changes in one turn
- **WHEN** Claude edits multiple files in a single turn
- **THEN** each change SHALL be summarized separately in the chat stream
- **THEN** the participant SHALL maintain an ordered list of all changes
