## ADDED Requirements

### Requirement: Model-layer request redirection
The participant SHALL redirect the Copilot runtime's model requests to a localhost proxy by setting the runtime's Copilot-API endpoint environment at client spawn.

#### Scenario: Proxy disabled passes through
- **WHEN** the model proxy is disabled
- **THEN** the participant SHALL NOT set the endpoint override, and the runtime SHALL call CAPI directly with the GitHub token (built-in-agent behavior)

#### Scenario: Redirect to VS Code Language Model API
- **WHEN** the model proxy is enabled
- **THEN** the participant SHALL spawn the runtime with its Copilot-API endpoint pointed at the localhost proxy, which serves the request through VS Code's Language Model API and streams the response back

#### Scenario: HTTP transport forced
- **WHEN** the model proxy is enabled
- **THEN** the participant SHALL force the HTTP responses transport (disable the WebSocket transport) so all model traffic flows through the localhost proxy

### Requirement: Model selection via the chat model picker
The participant SHALL use the model selected in the standard VS Code chat model picker to serve proxied requests, so third-party models require no special handling.

#### Scenario: Picked model backs the turn
- **WHEN** the proxy is enabled and the user has selected a model in the chat model picker
- **THEN** the participant SHALL pass that model per session (`createSession({ model })`) so the runtime's requests carry it and the proxy serves it through VS Code's Language Model API

#### Scenario: Per-conversation model over one subprocess
- **WHEN** multiple conversations run against the single warm runtime subprocess
- **THEN** each conversation's session SHALL use its own picked model, not a single process-wide model

#### Scenario: Third-party models need no extra config
- **WHEN** the selected model is a third-party model that VS Code's Language Model API exposes
- **THEN** the participant SHALL serve it through the proxy without any provider-specific configuration or credentials in this extension

### Requirement: Credential handling
The participant SHALL not manage third-party model credentials itself.

#### Scenario: Credentials owned by VS Code
- **WHEN** a proxied request is served by a third-party model
- **THEN** the credentials SHALL be owned by VS Code's Language Model providers, and this extension SHALL NOT store or log any model API keys

### Requirement: Enabling the proxy takes effect on client (re)start
The participant SHALL apply the proxy setting when the runtime client is (re)started, since the endpoint env is fixed at spawn.

#### Scenario: Toggle applied on restart
- **WHEN** the proxy setting changes while no sessions are active
- **THEN** the participant SHALL restart the runtime client so the new setting takes effect

### Requirement: Proxy disabled by default
The participant SHALL leave CAPI behavior unchanged unless the model proxy is explicitly enabled.

#### Scenario: No configuration
- **WHEN** the model proxy is not enabled
- **THEN** the participant SHALL behave identically to the built-in host agent, using CAPI models with the direct GitHub token
