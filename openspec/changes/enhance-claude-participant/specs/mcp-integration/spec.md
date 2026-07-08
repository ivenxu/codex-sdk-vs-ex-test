## ADDED Requirements

### Requirement: MCP server configuration
The system SHALL pass VS Code-configured MCP servers to the Claude SDK.

#### Scenario: Configure MCP servers from settings
- **WHEN** the user has configured `claude.mcpServers` in VS Code settings
- **THEN** the participant SHALL read the configuration and pass it via `Options.mcpServers`
- **THEN** the SDK SHALL start the MCP servers and make their tools available to Claude

#### Scenario: No MCP servers configured
- **WHEN** no `claude.mcpServers` configuration exists
- **THEN** the participant SHALL omit `mcpServers` from Options
- **THEN** Claude SHALL operate without MCP tools

### Requirement: MCP tool call routing
The system SHALL route MCP tool calls from Claude through the SDK's MCP connection manager.

#### Scenario: MCP tool call execution
- **WHEN** Claude calls an MCP tool during a turn
- **THEN** the SDK SHALL route the call to the appropriate MCP server via the configured connection
- **THEN** the result SHALL be returned to Claude through the SDK message stream

### Requirement: MCP elicitation handling
The system SHALL handle MCP server elicitation requests (server-initiated user input requests).

#### Scenario: Handle elicitation request
- **WHEN** an MCP server sends an elicitation request via `Options.onElicitation`
- **THEN** the participant SHALL display the elicitation message to the user
- **THEN** the participant SHALL ask the user for input via a confirmation dialog
- **THEN** the participant SHALL return the user's response to the SDK

#### Scenario: Elicitation cancellation
- **WHEN** the user cancels the elicitation dialog
- **THEN** the participant SHALL return a cancellation response to the SDK
- **THEN** Claude SHALL be informed the elicitation was declined
