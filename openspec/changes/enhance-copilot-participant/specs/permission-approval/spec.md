## ADDED Requirements

### Requirement: Tiered permission auto-approval
The participant SHALL evaluate each SDK permission request against an ordered set of auto-approval tiers before prompting the user.

#### Scenario: Session-internal resource is auto-approved
- **WHEN** a permission request targets a session-internal resource path
- **THEN** the participant SHALL resolve it with `approve-once` without prompting the user

#### Scenario: Read of an attached file is auto-approved
- **WHEN** a `read` permission request targets a path the user attached to the request
- **THEN** the participant SHALL resolve it with `approve-once` without prompting the user

#### Scenario: Read of an SDK temp file is auto-approved
- **WHEN** a `read` permission request targets a Copilot SDK tool-output temp file
- **THEN** the participant SHALL resolve it with `approve-once` without prompting the user

#### Scenario: Non-confirmation custom tool is auto-approved
- **WHEN** a `custom-tool` permission request names a tool that does not require confirmation
- **THEN** the participant SHALL resolve it with `approve-once` without prompting the user

### Requirement: Deferred permission registry
The participant SHALL park permission requests that require user confirmation in a per-session registry keyed by tool-call id, and resolve them when the user responds.

#### Scenario: User confirmation resolves the deferred
- **WHEN** a permission request requires confirmation and the user approves it
- **THEN** the matching deferred SHALL resolve with `approve-once`; if the user denies, it SHALL resolve with `reject`

#### Scenario: Concurrent permission requests
- **WHEN** multiple permission requests are outstanding at the same time
- **THEN** each SHALL be tracked by its own tool-call id and resolved independently

#### Scenario: Missing tool-call id is rejected
- **WHEN** a permission request has no tool-call id
- **THEN** the participant SHALL reject it as a fail-safe default
