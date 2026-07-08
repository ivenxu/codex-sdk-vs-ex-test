## ADDED Requirements

### Requirement: Client-tool MCP server lifecycle
The system SHALL start an in-process MCP server that exposes VS Code tools to Claude.

#### Scenario: Start client-tool server on session create
- **WHEN** a Claude session is created
- **THEN** the participant SHALL start a client-tool MCP server via stdio transport
- **THEN** the server SHALL be registered in `Options.mcpServers` under the name `vscode-tools`

#### Scenario: Stop client-tool server on session dispose
- **WHEN** a Claude session ends or is disposed
- **THEN** the participant SHALL stop the client-tool MCP server
- **THEN** all tool registrations SHALL be cleaned up

### Requirement: VS Code tool registration
The system SHALL register VS Code workspace tools as Claude-accessible MCP tools.

#### Scenario: Register readFile tool
- **WHEN** the client-tool MCP server starts
- **THEN** it SHALL register a `vscode_readFile` tool that reads file content via `vscode.workspace.fs.readFile()`
- **THEN** the tool SHALL accept a `filePath` parameter

#### Scenario: Register grepSearch tool
- **WHEN** the client-tool MCP server starts
- **THEN** it SHALL register a `vscode_grepSearch` tool that searches file contents via `vscode.workspace.findTextInFiles()`
- **THEN** the tool SHALL accept `pattern` and `includePattern` parameters

#### Scenario: Register fileSearch tool
- **WHEN** the client-tool MCP server starts
- **THEN** it SHALL register a `vscode_fileSearch` tool that searches for files via `vscode.workspace.findFiles()`
- **THEN** the tool SHALL accept a `pattern` parameter

#### Scenario: Register listDirectory tool
- **WHEN** the client-tool MCP server starts
- **THEN** it SHALL register a `vscode_listDirectory` tool that lists directory contents via `vscode.workspace.fs.readDirectory()`
- **THEN** the tool SHALL accept a `directoryPath` parameter

#### Scenario: Register readLints tool
- **WHEN** the client-tool MCP server starts
- **THEN** it SHALL register a `vscode_readLints` tool that reads diagnostics via `vscode.languages.getDiagnostics()`
- **THEN** the tool SHALL accept an optional `path` parameter

### Requirement: Tool namespace isolation
The system SHALL use `vscode_` prefix for all VS Code tools to avoid collision with Claude's built-in tools.

#### Scenario: Tool name prefix
- **WHEN** any VS Code tool is registered in the client-tool MCP server
- **THEN** its name SHALL be prefixed with `vscode_` (e.g., `vscode_readFile`, `vscode_grepSearch`)
- **THEN** Claude SHALL be able to call it using the prefixed name
