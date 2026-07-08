## ADDED Requirements

### Requirement: Permission mode configuration
The system SHALL expose Claude permission modes through the VS Code chat session "Set permission" picker.

#### Scenario: Default mode
- **WHEN** the user selects "Default Approvals" in the permission picker
- **THEN** the participant SHALL set `Options.permissionMode` to `'default'`
- **THEN** the SDK SHALL decide per-tool whether to request user approval via `canUseTool`

#### Scenario: Always-allow mode
- **WHEN** the user selects "Bypass Approvals" or "Autopilot" in the permission picker
- **THEN** the participant SHALL set `Options.permissionMode` to `'always-allow'`
- **THEN** the SDK SHALL auto-approve all tools without calling `canUseTool`

#### Scenario: Always-ask mode
- **WHEN** the user configures `claude.permissionMode` to `'always-ask'`
- **THEN** the participant SHALL set `Options.permissionMode` to `'always-ask'`
- **THEN** the SDK SHALL prompt the user via `canUseTool` on every tool call

#### Scenario: Never mode
- **WHEN** the user configures `claude.permissionMode` to `'never'`
- **THEN** the participant SHALL set `Options.permissionMode` to `'never'`
- **THEN** the SDK SHALL deny all tool calls without prompting

#### Scenario: Accept-edits mode
- **WHEN** the user configures `claude.permissionMode` to `'accept-edits'`
- **THEN** the participant SHALL set `Options.permissionMode` to `'accept-edits'`
- **THEN** the SDK SHALL auto-approve file edit tools and ask for other tools

### Requirement: Permission mode live update
The system SHALL apply permission mode changes immediately, without requiring a new session.

#### Scenario: Mid-session mode change
- **WHEN** the user changes permission mode during an active session
- **THEN** the participant SHALL pass the updated mode to the next `query()` call
- **THEN** the new mode SHALL take effect for subsequent tool calls
