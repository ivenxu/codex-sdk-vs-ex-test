## ADDED Requirements

### Requirement: Leading slash-command parsing
The participant SHALL detect a leading slash command in the prompt and handle it before dispatching a normal message.

#### Scenario: Non-command prompt
- **WHEN** the prompt does not start with a recognized slash command
- **THEN** the participant SHALL send the prompt to the session unchanged

### Requirement: Compact command
The participant SHALL support a `/compact` command that compacts session history.

#### Scenario: Compact history
- **WHEN** the prompt is `/compact`
- **THEN** the participant SHALL call the SDK history-compaction RPC, emit a short confirmation via `stream.markdown()`, and complete the turn without sending a normal message

### Requirement: Plan command
The participant SHALL support a `/plan` command that selects plan mode for the current turn.

#### Scenario: Plan mode
- **WHEN** the prompt begins with `/plan`
- **THEN** the participant SHALL send the turn with `agentMode` `plan`

### Requirement: Autopilot command
The participant SHALL support an `/autopilot` command that selects autopilot mode for the current turn.

#### Scenario: Autopilot mode
- **WHEN** the prompt begins with `/autopilot`
- **THEN** the participant SHALL send the turn with `agentMode` `autopilot`
