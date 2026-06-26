# VS Code LM Proxy Server — Technical Design

## Overview

Both `ClaudeProxyService` and `CodexProxyService` inside the VS Code agent host use the same
architectural pattern: **a local HTTP server on `127.0.0.1:0` that speaks a vendor REST API
on its inbound side and forwards to an upstream LLM API on its outbound side.** The only
upstream those production servers can reach is CAPI (the GitHub Copilot API) via the
`ICopilotApiService` DI service — a dependency unavailable to third-party extensions.

This document describes how to replicate the same pattern in a VS Code extension, replacing
the CAPI outbound leg with `vscode.lm.selectChatModels()` + `LanguageModelChat.sendRequest()`.

---

## Architecture

```
CLI / SDK                              VS Code Extension Host
─────────────────                      ──────────────────────────────────────────────────
Codex app-server  ──POST /v1/responses──► LmProxyServer ──► vscode.lm.selectChatModels()
                                                         └──► model.sendRequest() ──► stream
Claude SDK        ──POST /v1/messages──► LmProxyServer ──► same
                  ──GET  /v1/models──►   LmProxyServer ──► vscode.lm.selectChatModels()
```

### Why a local HTTP server?

The CLIs (codex, claude-code) are subprocess-spawned; they cannot call VS Code APIs
directly. The proxy bridges the spawn boundary with a loopback REST server.

### Why port 0?

`server.listen(0, '127.0.0.1', ...)` lets the OS pick any free port. The chosen address is
then handed to the subprocess as an environment variable before it starts, so there is no
port collision and no firewall rule needed.

---

## Proxy Lifecycle Pattern (from source)

```typescript
// Simplified from ClaudeProxyService / CodexProxyService
interface IProxyRuntime {
    server: http.Server;
    baseUrl: string;   // e.g. "http://127.0.0.1:54321"
    nonce: string;     // 256-bit hex — auth secret shared with subprocess
    inFlight: Set<{ ac: AbortController; res: http.ServerResponse; clientGone: boolean }>;
    refcount: number;
}
```

Key lifecycle rules:
1. **Refcounted start** — multiple callers share one server; refcount decrements on dispose.
2. **Subprocess invariant** — the subprocess owning `baseUrl`/`nonce` MUST be killed before
   the last handle is disposed; otherwise the port can change on the next `start()`.
3. **In-flight abort** — on teardown every in-flight `AbortController` is triggered before
   the socket is closed. This ensures the upstream promise rejects and the catch handler
   runs to close the client response.
4. **Nonce rotation** — the nonce is generated once per server bind. A fresh bind
   (refcount→0 → refcount→1) generates a new nonce, invalidating old subprocess connections.

---

## Nonce Authentication

### Codex proxy (plain nonce)
```
Authorization: Bearer <256-bit-hex-nonce>
```

### Claude proxy (nonce + sessionId)
```
Authorization: Bearer <nonce>.<sessionId>
```
The dot-separated form lets the proxy recover `sessionId` per-request without storing
extra state. The plain form is rejected (prevents the user's `ANTHROPIC_API_KEY` env var
from accidentally authenticating).

### For a VS Code extension proxy
Use the plain nonce form — simpler, sufficient for a single-tenant local proxy:
```typescript
function authenticate(req: http.IncomingMessage, nonce: string): boolean {
    const auth = req.headers['authorization'];
    return typeof auth === 'string' && auth === `Bearer ${nonce}`;
}
```

---

## Model Discovery — `GET /v1/models`

```typescript
// Anthropic SDK response shape
GET /v1/models → { data: Array<{ id, type, display_name }>, has_more, first_id, last_id }
```

**VS Code LM mapping:**
```typescript
const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
// Each vscode.LanguageModelChat has:
//   .id        — unique identifier (e.g. "claude-sonnet-4-5-20250514")
//   .name      — display name
//   .family    — family slug (e.g. "claude-sonnet-4-5")
//   .vendor    — "copilot"
//   .version   — version string
//   .maxInputTokens

const data = models.map(m => ({
    id: m.id,               // what the Claude SDK sends as `model:` in messages
    type: 'model',
    display_name: m.name,
    created_at: '1970-01-01T00:00:00Z',
}));
res.writeHead(200, { 'Content-Type': 'application/json' });
res.end(JSON.stringify({ data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null }));
```

**Note on model ID format:** The Claude SDK sends model IDs in dashed format
(`claude-haiku-4-5`) while CAPI expects dotted format (`claude-haiku-4.5`). VS Code's
`model.id` returns whichever format the model is registered with — test the round-trip.
`ClaudeProxyService` does an explicit rewrite in both directions via `tryParseClaudeModelId`.

---

## OpenAI Responses API — `POST /v1/responses`  *(Codex)*

### Inbound body shape
```jsonc
{
  "model": "o4-mini",
  "input": [
    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "Hello" }] },
    { "type": "function_call", "name": "readFile", "call_id": "c1", "arguments": "{\"path\":\"/foo\"}" },
    { "type": "function_call_output", "call_id": "c1", "output": "file contents" },
    { "type": "reasoning", "summary": [...], "encrypted_content": "..." }
  ],
  "stream": true,
  "tools": [...],
  "instructions": "system prompt text"
}
```

### Mapping to VS Code LM messages
```typescript
import * as vscode from 'vscode';

function responsesInputToVsCodeMessages(
    input: unknown[],
    instructions: string | undefined
): vscode.LanguageModelChatMessage[] {
    const msgs: vscode.LanguageModelChatMessage[] = [];

    if (instructions) {
        msgs.push(new vscode.LanguageModelChatMessage(
            vscode.LanguageModelChatMessageRole.System,
            instructions
        ));
    }

    for (const item of input) {
        const i = item as Record<string, unknown>;
        if (i.type === 'message') {
            const role = i.role === 'assistant'
                ? vscode.LanguageModelChatMessageRole.Assistant
                : vscode.LanguageModelChatMessageRole.User;
            const content = Array.isArray(i.content)
                ? (i.content as Array<{ type: string; text?: string }>)
                    .filter(c => c.type === 'input_text' || c.type === 'text')
                    .map(c => c.text ?? '')
                    .join('')
                : String(i.content ?? '');
            msgs.push(new vscode.LanguageModelChatMessage(role, content));
        } else if (i.type === 'function_call') {
            // Outbound tool call from model — represented as assistant message
            msgs.push(new vscode.LanguageModelChatMessage(
                vscode.LanguageModelChatMessageRole.Assistant,
                [new vscode.LanguageModelToolCallPart(
                    String(i.call_id),
                    String(i.name),
                    JSON.parse(String(i.arguments ?? '{}'))
                )]
            ));
        } else if (i.type === 'function_call_output') {
            // Tool result — User message with ToolResultPart
            msgs.push(new vscode.LanguageModelChatMessage(
                vscode.LanguageModelChatMessageRole.User,
                [new vscode.LanguageModelToolResultPart(
                    String(i.call_id),
                    [new vscode.LanguageModelTextPart(String(i.output ?? ''))]
                )]
            ));
        }
        // 'reasoning' items are skipped — VS Code LM API has no equivalent
    }
    return msgs;
}
```

### Streaming back to Codex

Codex expects OpenAI Responses SSE (`event: response.output_text.delta`, etc.).
If you just need the text through, the simplest approach is a single non-streamed call:

```typescript
const chatResp = await model.sendRequest(messages, { tools }, token);
let text = '';
for await (const part of chatResp.stream) {
    if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
    }
}
// Return as a non-streaming response.json
```

For true streaming, emit Responses-format SSE:
```
event: response.created
data: {"type":"response.created","response":{"id":"...","status":"in_progress",...}}

event: response.output_item.added
data: {"type":"response.output_item.added","item":{"type":"message","role":"assistant",...}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"Hello"}

event: response.completed
data: {"type":"response.completed","response":{"status":"completed",...}}
```

---

## Anthropic Messages API — `POST /v1/messages`  *(Claude SDK)*

### Inbound body shape
```jsonc
{
  "model": "claude-sonnet-4-5",
  "system": "You are a coding assistant.",
  "messages": [
    { "role": "user",      "content": "Hello" },
    { "role": "assistant", "content": [{ "type": "tool_use", "id": "t1", "name": "readFile", "input": {...} }] },
    { "role": "user",      "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "file text" }] }
  ],
  "max_tokens": 4096,
  "stream": true,
  "tools": [{ "name": "readFile", "description": "...", "input_schema": { "type": "object", ... } }]
}
```

### Mapping to VS Code LM messages
```typescript
function anthropicMessagesToVsCode(
    messages: Array<{ role: string; content: unknown }>,
    system: string | undefined
): vscode.LanguageModelChatMessage[] {
    const out: vscode.LanguageModelChatMessage[] = [];

    if (system) {
        out.push(new vscode.LanguageModelChatMessage(
            vscode.LanguageModelChatMessageRole.System,
            system
        ));
    }

    for (const msg of messages) {
        const role = msg.role === 'assistant'
            ? vscode.LanguageModelChatMessageRole.Assistant
            : vscode.LanguageModelChatMessageRole.User;

        const content = msg.content;
        if (typeof content === 'string') {
            out.push(new vscode.LanguageModelChatMessage(role, content));
            continue;
        }

        // Content block array
        const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | vscode.LanguageModelToolResultPart)[] = [];
        for (const block of content as Array<Record<string, unknown>>) {
            if (block.type === 'text') {
                parts.push(new vscode.LanguageModelTextPart(String(block.text ?? '')));
            } else if (block.type === 'tool_use') {
                parts.push(new vscode.LanguageModelToolCallPart(
                    String(block.id),
                    String(block.name),
                    block.input as Record<string, unknown>
                ));
            } else if (block.type === 'tool_result') {
                const resultContent = typeof block.content === 'string'
                    ? block.content
                    : (Array.isArray(block.content)
                        ? (block.content as Array<{ type: string; text?: string }>)
                            .filter(c => c.type === 'text')
                            .map(c => c.text ?? '').join('')
                        : '');
                parts.push(new vscode.LanguageModelToolResultPart(
                    String(block.tool_use_id),
                    [new vscode.LanguageModelTextPart(resultContent)]
                ));
            }
        }
        out.push(new vscode.LanguageModelChatMessage(role, parts));
    }
    return out;
}
```

### Mapping Anthropic tools to VS Code LM tools
```typescript
function anthropicToolsToVsCode(
    tools: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>
): vscode.LanguageModelChatTool[] {
    return tools.map(t => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.input_schema,
    }));
}
```

### Streaming back to Claude SDK

The Claude SDK expects Anthropic SSE format:
```
event: message_start
data: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[],"stop_reason":null,...}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}

event: message_stop
data: {"type":"message_stop"}
```

For tool calls, the Claude SDK needs `content_block_start` with `type: "tool_use"` then
`input_json_delta` frames for the JSON-encoded arguments.

**VS Code LM → Anthropic SSE adapter:**
```typescript
async function streamVsCodeToAnthropic(
    chatResp: vscode.LanguageModelChatResponse,
    res: http.ServerResponse,
    msgId: string,
    modelId: string,
    token: vscode.CancellationToken
): Promise<void> {
    const writeSSE = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    writeSSE('message_start', {
        type: 'message_start',
        message: { id: msgId, type: 'message', role: 'assistant', model: modelId,
                   content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } }
    });
    writeSSE('content_block_start', { type: 'content_block_start', index: 0,
        content_block: { type: 'text', text: '' } });

    let outputTokens = 0;
    const toolCallBuffers = new Map<string, { name: string; args: string; index: number }>();
    let nextContentIndex = 1;

    for await (const part of chatResp.stream) {
        if (token.isCancellationRequested) { break; }

        if (part instanceof vscode.LanguageModelTextPart) {
            outputTokens += part.value.length / 4; // rough approximation
            writeSSE('content_block_delta', {
                type: 'content_block_delta', index: 0,
                delta: { type: 'text_delta', text: part.value }
            });
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
            const idx = nextContentIndex++;
            toolCallBuffers.set(part.callId, { name: part.name, args: '', index: idx });
            writeSSE('content_block_start', {
                type: 'content_block_start', index: idx,
                content_block: { type: 'tool_use', id: part.callId, name: part.name, input: {} }
            });
            // arguments arrive as a complete object; emit as a single input_json_delta
            const argsStr = JSON.stringify(part.input);
            writeSSE('content_block_delta', {
                type: 'content_block_delta', index: idx,
                delta: { type: 'input_json_delta', partial_json: argsStr }
            });
            writeSSE('content_block_stop', { type: 'content_block_stop', index: idx });
        }
    }

    writeSSE('content_block_stop', { type: 'content_block_stop', index: 0 });
    writeSSE('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: toolCallBuffers.size > 0 ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: Math.ceil(outputTokens) }
    });
    writeSSE('message_stop', { type: 'message_stop' });
    res.end();
}
```

---

## Complete Extension Proxy Skeleton

```typescript
import * as http from 'http';
import * as vscode from 'vscode';
import { AddressInfo } from 'net';
import * as crypto from 'crypto';

function generateNonce(): string {
    return crypto.randomBytes(32).toString('hex');
}

function writeJsonError(res: http.ServerResponse, status: number, type: string, msg: string): void {
    if (res.headersSent || res.writableEnded) { return; }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type, message: msg } }));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

export interface ILmProxyHandle extends vscode.Disposable {
    readonly baseUrl: string;  // "http://127.0.0.1:<port>"
    readonly nonce: string;    // set as Bearer token in subprocess env
}

interface IRuntime {
    server: http.Server;
    baseUrl: string;
    nonce: string;
    inFlight: Set<{ ac: AbortController; res: http.ServerResponse; clientGone: boolean }>;
    refcount: number;
}

export class LmProxyServer implements vscode.Disposable {
    private _runtime: IRuntime | undefined;
    private _starting: Promise<IRuntime> | undefined;
    private _disposed = false;

    async start(): Promise<ILmProxyHandle> {
        if (this._disposed) { throw new Error('disposed'); }
        const rt = await this._ensureRuntime();
        rt.refcount++;
        let released = false;
        return {
            baseUrl: rt.baseUrl,
            nonce: rt.nonce,
            dispose: () => {
                if (released) { return; }
                released = true;
                this._release(rt);
            }
        };
    }

    dispose(): void {
        if (this._disposed) { return; }
        this._disposed = true;
        this._teardown();
    }

    private _ensureRuntime(): Promise<IRuntime> {
        if (this._runtime) { return Promise.resolve(this._runtime); }
        if (!this._starting) {
            this._starting = (async () => {
                try {
                    const rt = await this._bind();
                    if (this._disposed) {
                        rt.server.closeAllConnections(); rt.server.close();
                        throw new Error('disposed during bind');
                    }
                    this._runtime = rt;
                    return rt;
                } finally {
                    this._starting = undefined;
                }
            })();
        }
        return this._starting;
    }

    private _release(rt: IRuntime): void {
        if (this._runtime !== rt) { return; }
        if (--rt.refcount === 0) { this._teardown(); }
    }

    private _teardown(): void {
        const rt = this._runtime;
        if (!rt) { return; }
        this._runtime = undefined;
        for (const entry of rt.inFlight) { entry.ac.abort(); }
        rt.server.closeAllConnections();
        rt.server.close();
    }

    private async _bind(): Promise<IRuntime> {
        const nonce = generateNonce();
        const inFlight = new Set<IRuntime['inFlight'] extends Set<infer T> ? T : never>();
        const server = http.createServer();

        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.removeAllListeners('error');
                resolve();
            });
        });

        const addr = server.address() as AddressInfo;
        const baseUrl = `http://127.0.0.1:${addr.port}`;
        const rt: IRuntime = { server, baseUrl, nonce, inFlight, refcount: 0 };

        server.on('request', (req, res) => {
            this._handle(req, res, rt).catch(err => {
                if (!res.headersSent) { writeJsonError(res, 500, 'api_error', String(err)); }
                else if (!res.writableEnded) { res.end(); }
            });
        });
        return rt;
    }

    private async _handle(req: http.IncomingMessage, res: http.ServerResponse, rt: IRuntime): Promise<void> {
        const method = req.method ?? 'GET';
        const path = new URL(req.url ?? '/', 'http://localhost').pathname;

        if (method === 'GET' && path === '/') {
            res.writeHead(200); res.end('ok'); return;
        }

        const auth = req.headers['authorization'];
        if (auth !== `Bearer ${rt.nonce}`) {
            writeJsonError(res, 401, 'authentication_error', 'Invalid authentication'); return;
        }

        if (method === 'GET' && path === '/v1/models') {
            await this._models(res); return;
        }
        if (method === 'POST' && (path === '/v1/messages' || path === '/v1/responses' || path === '/v1/chat/completions')) {
            await this._chat(req, res, rt, path); return;
        }

        writeJsonError(res, 404, 'not_found_error', `No route: ${method} ${path}`);
    }

    private async _models(res: http.ServerResponse): Promise<void> {
        const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        const data = models.map(m => ({ id: m.id, type: 'model', display_name: m.name }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null }));
    }

    private async _chat(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        rt: IRuntime,
        path: string
    ): Promise<void> {
        const bodyStr = await readBody(req);
        const body = JSON.parse(bodyStr) as Record<string, unknown>;

        // --- resolve model ---
        const requestedModel = typeof body.model === 'string' ? body.model : undefined;
        const candidates = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        const model = (requestedModel
            ? candidates.find(m => m.id === requestedModel || m.family === requestedModel)
            : candidates[0]);
        if (!model) {
            writeJsonError(res, 404, 'not_found_error', `Model not available: ${requestedModel ?? '(none)'}`); return;
        }

        // --- build messages (adapt based on inbound API format) ---
        let messages: vscode.LanguageModelChatMessage[];
        let tools: vscode.LanguageModelChatTool[] = [];

        if (path === '/v1/messages') {
            messages = anthropicMessagesToVsCode(
                body.messages as Array<{ role: string; content: unknown }>,
                body.system as string | undefined
            );
            if (Array.isArray(body.tools)) {
                tools = anthropicToolsToVsCode(body.tools as Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>);
            }
        } else {
            // OpenAI Chat Completions or Responses — adapt similarly
            messages = openaiMessagesToVsCode(body);
        }

        // --- track in-flight ---
        const cts = new vscode.CancellationTokenSource();
        const entry = { ac: new AbortController(), res, clientGone: false };
        rt.inFlight.add(entry);
        req.on('close', () => { entry.clientGone = true; cts.cancel(); });

        try {
            const options: vscode.LanguageModelChatRequestOptions = tools.length > 0 ? { tools } : {};
            const chatResp = await model.sendRequest(messages, options, cts.token);

            const stream = body.stream === true;
            if (!stream) {
                // Non-streaming: collect and return JSON
                let text = '';
                const toolCalls: vscode.LanguageModelToolCallPart[] = [];
                for await (const part of chatResp.stream) {
                    if (part instanceof vscode.LanguageModelTextPart) { text += part.value; }
                    else if (part instanceof vscode.LanguageModelToolCallPart) { toolCalls.push(part); }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(buildAnthropicNonStreamResponse(model.id, text, toolCalls)));
            } else {
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
                await streamVsCodeToAnthropic(chatResp, res, `msg_${Date.now()}`, model.id, cts.token);
            }
        } catch (err) {
            if (!entry.clientGone) {
                writeJsonError(res, 502, 'api_error', String(err));
            }
        } finally {
            cts.dispose();
            rt.inFlight.delete(entry);
        }
    }
}
```

---

## Key Differences vs. CAPI-backed Proxies

| | Production proxies | Extension proxy (this doc) |
|---|---|---|
| Outbound auth | GitHub token (`Authorization: Bearer <github-token>`) | None — `model.sendRequest()` uses VS Code's own token |
| Token rotation | `handle.setToken(newToken)` — live update | Not needed |
| Tool execution | Sent to model verbatim; CLI handles results | Same |
| Streaming format | Proxied raw bytes from CAPI | Must synthesise SSE from `LanguageModelChatResponse.stream` |
| Cancellation | `AbortController` on `fetch()` | `vscode.CancellationTokenSource` on `model.sendRequest()` |
| Model ID format | CAPI dotted (`claude-haiku-4.5`) vs SDK dashed (`claude-haiku-4-5`) | VS Code's `.id` — test what the SDK expects |
| Rate limits / quota | CAPI returns HTTP 429 | VS Code LM throws `vscode.LanguageModelError` |

---

## Error Handling

```typescript
import * as vscode from 'vscode';

function lmErrorToHttpStatus(err: unknown): { status: number; type: string; message: string } {
    if (err instanceof vscode.LanguageModelError) {
        switch (err.code) {
            case vscode.LanguageModelError.NotFound.name:
                return { status: 404, type: 'not_found_error', message: err.message };
            case vscode.LanguageModelError.Blocked.name:
                return { status: 451, type: 'permission_error', message: err.message };
            case vscode.LanguageModelError.NoPermissions.name:
                return { status: 403, type: 'permission_error', message: err.message };
            default:
                return { status: 500, type: 'api_error', message: err.message };
        }
    }
    if (err instanceof Error && err.name === 'AbortError') {
        return { status: 499, type: 'cancelled', message: 'Request cancelled' };
    }
    return { status: 502, type: 'api_error', message: String(err) };
}
```

---

## Integration with Codex CLI

After `handle = await proxy.start()`, set env vars before spawning the subprocess:

```typescript
// For Codex app-server (OpenAI Responses API)
env: {
    OPENAI_BASE_URL: `${handle.baseUrl}/v1`,
    OPENAI_API_KEY: handle.nonce,
}

// For Claude SDK
env: {
    ANTHROPIC_BASE_URL: handle.baseUrl,
    ANTHROPIC_AUTH_TOKEN: `${handle.nonce}.${sessionId}`,
}
```

The subprocess must be terminated before `handle.dispose()` is called, to avoid it
connecting to a stale (possibly rebound) port.

---

## Debug Dump (optional)

`CodexProxyService` uses `VSCODE_CODEX_PROXY_DUMP_DIR` to write every request body and
response stream to disk. Replicate with:
```typescript
const dumpDir = process.env['VSCODE_LM_PROXY_DUMP_DIR'];
if (dumpDir) {
    fs.writeFileSync(path.join(dumpDir, `req-${Date.now()}.json`), bodyStr);
}
```
