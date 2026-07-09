## ADDED Requirements

### Requirement: GitHub token rotation handling
The participant SHALL detect changes to the GitHub Copilot token and refresh the SDK client safely.

#### Scenario: Token changes with no active sessions
- **WHEN** a request presents a GitHub token different from the last-seen token and no sessions are active
- **THEN** the participant SHALL stop the current SDK client and lazily recreate it with the new token

#### Scenario: Token changes with active sessions
- **WHEN** a request presents a changed token while sessions are active
- **THEN** the participant SHALL NOT stop the client mid-conversation, preserving active session state

### Requirement: Restricted-telemetry gate
The participant SHALL read the token metadata fields and gate restricted telemetry on the `rt` field.

#### Scenario: Restricted telemetry enabled
- **WHEN** the parsed token header contains `rt=1`
- **THEN** the participant SHALL enable restricted telemetry

#### Scenario: Restricted telemetry disabled
- **WHEN** the parsed token header does not contain `rt=1`
- **THEN** the participant SHALL NOT enable restricted telemetry
