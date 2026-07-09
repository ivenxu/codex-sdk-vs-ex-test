## ADDED Requirements

### Requirement: Per-turn agent mode from slash commands
The participant SHALL resolve the per-turn SDK `agentMode` from a leading slash command, defaulting to `interactive`. (A chat participant has no agent-host `(mode, autoApprove)` session-config surface.)

#### Scenario: Plan mode
- **WHEN** the prompt begins with `/plan`
- **THEN** the participant SHALL use `agentMode` `plan` for that turn

#### Scenario: Autopilot mode
- **WHEN** the prompt begins with `/autopilot`
- **THEN** the participant SHALL use `agentMode` `autopilot` for that turn

#### Scenario: Interactive default
- **WHEN** the prompt has no recognized mode slash command
- **THEN** the participant SHALL use `agentMode` `interactive`

### Requirement: Apply mode per turn
The participant SHALL apply the resolved mode on the message it sends.

#### Scenario: Mode applied on send
- **WHEN** a message is dispatched
- **THEN** the participant SHALL pass the resolved `agentMode` via `MessageOptions.agentMode` on `session.send()`

### Requirement: Plan-mode exit handling
The participant SHALL handle the SDK exit-plan-mode request.

#### Scenario: Exit plan mode
- **WHEN** the SDK issues an `onExitPlanModeRequest` callback
- **THEN** the participant SHALL surface it for confirmation and return the user's decision to the SDK

### Requirement: Autopilot suppresses approval prompts
The participant SHALL allow autopilot mode to run without per-tool user prompts.

#### Scenario: Autopilot runs unattended
- **WHEN** the turn is sent with `agentMode` `autopilot`
- **THEN** tool executions SHALL proceed without prompting the user for approval
