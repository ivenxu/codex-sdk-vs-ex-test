## ADDED Requirements

### Requirement: VS Code attachment conversion
The participant SHALL convert VS Code chat attachments into SDK `Attachment` objects and include them when sending a message.

#### Scenario: File reference attachment
- **WHEN** the request includes a file reference
- **THEN** the participant SHALL produce an `AttachmentFile` with the file path, including a line range when the reference specifies one

#### Scenario: Editor selection attachment
- **WHEN** the request includes an editor selection
- **THEN** the participant SHALL produce an `AttachmentSelection` describing the selected range

#### Scenario: Image attachment
- **WHEN** the request includes an image
- **THEN** the participant SHALL produce an `AttachmentBlob` carrying the image data

#### Scenario: Attachments passed to send
- **WHEN** one or more attachments are produced for a message
- **THEN** the participant SHALL pass them via `session.send({ prompt, attachments })`

#### Scenario: Unsupported attachment kinds
- **WHEN** an attachment kind cannot be represented as an SDK attachment
- **THEN** the participant SHALL skip it without failing the request
