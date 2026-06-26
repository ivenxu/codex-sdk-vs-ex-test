/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as vscode from 'vscode';
import { makeId, startSSE, writeJSON, writeNamedSSEEvent, RouteHandler } from './proxyServer';

// ---------------------------------------------------------------------------
// Minimal type shapes for Anthropic Messages API (no SDK dependency)
// ---------------------------------------------------------------------------

interface AnthropicTextBlock { type: 'text'; text: string }
interface AnthropicImageBlock { type: 'image'; source: { type: string; media_type?: string; data?: string; url?: string } }
interface AnthropicToolUseBlock { type: 'tool_use'; id: string; name: string; input: object }
interface AnthropicToolResultBlock { type: 'tool_result'; tool_use_id: string; content?: string | AnthropicContentBlock[] }
interface AnthropicThinkingBlock { type: 'thinking'; thinking: string; signature?: string }
interface AnthropicRedactedThinkingBlock { type: 'redacted_thinking'; data: string }
interface AnthropicDocumentBlock { type: 'document'; title?: string }

type AnthropicContentBlock =
	| AnthropicTextBlock
	| AnthropicImageBlock
	| AnthropicToolUseBlock
	| AnthropicToolResultBlock
	| AnthropicThinkingBlock
	| AnthropicRedactedThinkingBlock
	| AnthropicDocumentBlock
	| { type: string };

interface AnthropicMessage {
	role: 'user' | 'assistant';
	content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
	name: string;
	description?: string;
	input_schema?: object;
	type?: string;
}

interface MessagesRequest {
	model: string;
	messages: AnthropicMessage[];
	system?: string | Array<{ type: string; text?: string }>;
	tools?: AnthropicTool[];
	tool_choice?: { type: string; name?: string };
	max_tokens?: number;
	stream?: boolean;
	thinking?: { type: string; budget_tokens?: number };
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Input conversion: Anthropic messages → vscode.LanguageModelChatMessage[]
// ---------------------------------------------------------------------------

function convertAnthropicContentBlock(
	block: AnthropicContentBlock,
): vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | vscode.LanguageModelToolResultPart | undefined {
	switch (block.type) {
		case 'text':
			return new vscode.LanguageModelTextPart((block as AnthropicTextBlock).text);
		case 'tool_use': {
			const tb = block as AnthropicToolUseBlock;
			return new vscode.LanguageModelToolCallPart(tb.id, tb.name, tb.input);
		}
		case 'tool_result': {
			const tr = block as AnthropicToolResultBlock;
			let contentParts: vscode.LanguageModelTextPart[];
			if (typeof tr.content === 'string') {
				contentParts = [new vscode.LanguageModelTextPart(tr.content)];
			} else if (Array.isArray(tr.content)) {
				contentParts = tr.content
					.filter(c => c.type === 'text')
					.map(c => new vscode.LanguageModelTextPart((c as AnthropicTextBlock).text));
			} else {
				contentParts = [new vscode.LanguageModelTextPart('')];
			}
			return new vscode.LanguageModelToolResultPart(tr.tool_use_id, contentParts);
		}
		case 'image':
			// Images not representable; use placeholder
			return new vscode.LanguageModelTextPart('[Image]');
		case 'document': {
			const db = block as AnthropicDocumentBlock;
			return new vscode.LanguageModelTextPart(`[Document${db.title ? ': ' + db.title : ''}]`);
		}
		case 'thinking':
		case 'redacted_thinking':
			// Drop cleanly — encrypted blobs can't be replayed; stringifying is harmful
			return undefined;
		default:
			return undefined;
	}
}

export function convertAnthropicMessagesToVSCode(
	messages: AnthropicMessage[],
	system?: string | Array<{ type: string; text?: string }>,
): vscode.LanguageModelChatMessage[] {
	const result: vscode.LanguageModelChatMessage[] = [];

	// System prompt → prepend as an assistant message with [SYSTEM] prefix
	// (VS Code LM API has no System role in the public API)
	if (system) {
		let systemText = '';
		if (typeof system === 'string') {
			systemText = system;
		} else if (Array.isArray(system)) {
			systemText = system
				.filter(b => b.type === 'text' && b.text)
				.map(b => b.text!)
				.join('\n\n');
		}
		if (systemText) {
			result.push(vscode.LanguageModelChatMessage.Assistant(`[SYSTEM] ${systemText}`, 'System'));
		}
	}

	for (const msg of messages) {
		const content = msg.content;
		if (msg.role === 'user') {
			if (typeof content === 'string') {
				result.push(vscode.LanguageModelChatMessage.User(content));
			} else {
				const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart> = [];
				for (const block of content) {
					const part = convertAnthropicContentBlock(block);
					if (part instanceof vscode.LanguageModelTextPart || part instanceof vscode.LanguageModelToolResultPart) {
						parts.push(part);
					}
				}
				result.push(vscode.LanguageModelChatMessage.User(parts.length > 0 ? parts : ''));
			}
		} else {
			// assistant
			if (typeof content === 'string') {
				result.push(vscode.LanguageModelChatMessage.Assistant(content));
			} else {
				const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
				for (const block of content) {
					const part = convertAnthropicContentBlock(block);
					if (part instanceof vscode.LanguageModelTextPart || part instanceof vscode.LanguageModelToolCallPart) {
						parts.push(part);
					}
				}
				result.push(vscode.LanguageModelChatMessage.Assistant(parts.length > 0 ? parts : ''));
			}
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Tools conversion
// ---------------------------------------------------------------------------

function convertAnthropicTools(tools: AnthropicTool[]): vscode.LanguageModelChatTool[] {
	return tools.map(t => ({
		name: t.name,
		description: t.description ?? '',
		inputSchema: (t.input_schema as Record<string, unknown>) ?? {},
	}));
}

function convertAnthropicToolChoice(
	toolChoice: { type: string; name?: string } | undefined,
): vscode.LanguageModelChatToolMode | undefined {
	if (!toolChoice) { return undefined; }
	switch (toolChoice.type) {
		case 'auto': return vscode.LanguageModelChatToolMode.Auto;
		case 'any': return vscode.LanguageModelChatToolMode.Required;
		case 'tool': return vscode.LanguageModelChatToolMode.Required; // can't force a specific tool
		case 'none': return undefined; // handled by omitting tools
		default: return vscode.LanguageModelChatToolMode.Auto;
	}
}

// ---------------------------------------------------------------------------
// Output: VS Code stream → Anthropic Messages SSE
// ---------------------------------------------------------------------------

async function streamMessagesSSE(
	res: http.ServerResponse,
	vsResponse: vscode.LanguageModelChatResponse,
	modelId: string,
	inputTokens: number,
	token: vscode.CancellationToken,
): Promise<void> {
	const messageId = makeId('msg');

	const ThinkingPartCtor = (vscode as unknown as Record<string, unknown>)['LanguageModelThinkingPart'] as (new (...args: unknown[]) => unknown) | undefined;

	startSSE(res);

	writeNamedSSEEvent(res, 'message_start', {
		type: 'message_start',
		message: {
			id: messageId,
			type: 'message',
			role: 'assistant',
			content: [],
			model: modelId,
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: inputTokens, output_tokens: 0 },
		},
	});
	writeNamedSSEEvent(res, 'ping', { type: 'ping' });

	let blockIndex = 0;
	let textBlockOpen = false;
	let accumulatedText = '';
	let outputTokens = 0;
	let stopReason = 'end_turn';
	const toolCalls: string[] = []; // track if any tool_use blocks were opened

	const openTextBlock = () => {
		if (textBlockOpen) { return; }
		textBlockOpen = true;
		writeNamedSSEEvent(res, 'content_block_start', {
			type: 'content_block_start',
			index: blockIndex,
			content_block: { type: 'text', text: '' },
		});
	};

	const closeTextBlock = () => {
		if (!textBlockOpen) { return; }
		textBlockOpen = false;
		writeNamedSSEEvent(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
		blockIndex++;
	};

	try {
		for await (const part of vsResponse.stream) {
			if (token.isCancellationRequested) { break; }

			if (part instanceof vscode.LanguageModelTextPart) {
				openTextBlock();
				accumulatedText += part.value;
				// rough token estimate (4 chars/token)
				outputTokens += Math.ceil(part.value.length / 4);
				writeNamedSSEEvent(res, 'content_block_delta', {
					type: 'content_block_delta',
					index: blockIndex,
					delta: { type: 'text_delta', text: part.value },
				});
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				// Close any open text block first
				closeTextBlock();
				stopReason = 'tool_use';
				toolCalls.push(part.callId);

				const argsJson = JSON.stringify(part.input);
				writeNamedSSEEvent(res, 'content_block_start', {
					type: 'content_block_start',
					index: blockIndex,
					content_block: { type: 'tool_use', id: part.callId, name: part.name, input: {} },
				});
				writeNamedSSEEvent(res, 'content_block_delta', {
					type: 'content_block_delta',
					index: blockIndex,
					delta: { type: 'input_json_delta', partial_json: argsJson },
				});
				writeNamedSSEEvent(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
				blockIndex++;
			} else if (part instanceof vscode.LanguageModelDataPart) {
				if (part.mimeType === 'application/vnd.vscode.lm.usage') {
					try {
						const usage = JSON.parse(new TextDecoder().decode(part.data)) as { outputTokens?: number; inputTokens?: number };
						if (usage.outputTokens) { outputTokens = usage.outputTokens; }
					} catch { /* ignore */ }
				}
			} else if (ThinkingPartCtor && part instanceof ThinkingPartCtor) {
				// Unencrypted thinking — emit as thinking block BEFORE text content
				// Only forward if we haven't started the text block yet
				const thinkPart = part as { value: string | string[]; metadata?: Record<string, unknown> };
				const isDone = thinkPart.metadata?.['vscode_reasoning_done'] || thinkPart.metadata?.['vscodeReasoningDone'];
				const thinkText = Array.isArray(thinkPart.value) ? thinkPart.value.join('') : (thinkPart.value ?? '');

				if (!isDone && thinkText && !textBlockOpen && toolCalls.length === 0) {
					// Open a thinking block if one isn't already open
					if (!thinkText) { continue; }
					writeNamedSSEEvent(res, 'content_block_start', {
						type: 'content_block_start',
						index: blockIndex,
						content_block: { type: 'thinking', thinking: '' },
					});
					writeNamedSSEEvent(res, 'content_block_delta', {
						type: 'content_block_delta',
						index: blockIndex,
						delta: { type: 'thinking_delta', thinking: thinkText },
					});
					writeNamedSSEEvent(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
					blockIndex++;
				}
				// If textBlockOpen or after tool calls, drop thinking (it arrived too late to insert)
			} else if ((part as object)?.constructor?.name === 'LanguageModelThinkingPart') {
				// Same handling via constructor name fallback (same as flowEngine.ts pattern)
				const thinkPart = part as { value: string | string[]; metadata?: Record<string, unknown> };
				const isDone = thinkPart.metadata?.['vscode_reasoning_done'] || thinkPart.metadata?.['vscodeReasoningDone'];
				const thinkText = Array.isArray(thinkPart.value) ? thinkPart.value.join('') : (thinkPart.value ?? '');
				if (!isDone && thinkText && !textBlockOpen && toolCalls.length === 0) {
					writeNamedSSEEvent(res, 'content_block_start', {
						type: 'content_block_start',
						index: blockIndex,
						content_block: { type: 'thinking', thinking: '' },
					});
					writeNamedSSEEvent(res, 'content_block_delta', {
						type: 'content_block_delta',
						index: blockIndex,
						delta: { type: 'thinking_delta', thinking: thinkText },
					});
					writeNamedSSEEvent(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
					blockIndex++;
				}
			}
		}
	} catch { /* stream errors handled by VS Code */ }

	// Close any open text block
	closeTextBlock();

	// Finalize
	writeNamedSSEEvent(res, 'message_delta', {
		type: 'message_delta',
		delta: { stop_reason: stopReason, stop_sequence: null },
		usage: { output_tokens: outputTokens },
	});
	writeNamedSSEEvent(res, 'message_stop', { type: 'message_stop' });

	res.end();
}

// ---------------------------------------------------------------------------
// Non-streaming response
// ---------------------------------------------------------------------------

async function collectMessagesResponse(
	vsResponse: vscode.LanguageModelChatResponse,
	modelId: string,
	inputTokens: number,
	token: vscode.CancellationToken,
): Promise<object> {
	const messageId = makeId('msg');
	let text = '';
	const toolCalls: Array<{ id: string; name: string; input: object }> = [];
	let outputTokens = 0;

	try {
		for await (const part of vsResponse.stream) {
			if (token.isCancellationRequested) { break; }
			if (part instanceof vscode.LanguageModelTextPart) {
				text += part.value;
				outputTokens += Math.ceil(part.value.length / 4);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({ id: part.callId, name: part.name, input: part.input });
			}
		}
	} catch { /* ignore */ }

	const content: unknown[] = [];
	if (text) { content.push({ type: 'text', text }); }
	for (const tc of toolCalls) {
		content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
	}

	return {
		id: messageId,
		type: 'message',
		role: 'assistant',
		content,
		model: modelId,
		stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
		stop_sequence: null,
		usage: { input_tokens: inputTokens, output_tokens: outputTokens },
	};
}

// ---------------------------------------------------------------------------
// Main handler factory
// ---------------------------------------------------------------------------

export function createMessagesHandler(): RouteHandler {
	return async (_req: http.IncomingMessage, res: http.ServerResponse, body: unknown) => {
		const req = body as MessagesRequest;

		if (!req.model) {
			writeJSON(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: '`model` field is required' } });
			return;
		}
		if (!Array.isArray(req.messages) || req.messages.length === 0) {
			writeJSON(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: '`messages` array is required and must not be empty' } });
			return;
		}

		// Model lookup — consumer provides exact ID
		const models = await vscode.lm.selectChatModels({ id: req.model });
		if (models.length === 0) {
			writeJSON(res, 404, { type: 'error', error: { type: 'not_found_error', message: `Model '${req.model}' not found` } });
			return;
		}
		const model = models[0];

		const vsMessages = convertAnthropicMessagesToVSCode(req.messages, req.system);
		if (vsMessages.length === 0) {
			writeJSON(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'No messages could be converted' } });
			return;
		}

		const options: vscode.LanguageModelChatRequestOptions = {};

		// tool_choice: 'none' means omit tools entirely
		const omitTools = req.tool_choice?.type === 'none';

		if (!omitTools && Array.isArray(req.tools) && req.tools.length > 0) {
			options.tools = convertAnthropicTools(req.tools);
			const mode = convertAnthropicToolChoice(req.tool_choice);
			if (mode !== undefined) { options.toolMode = mode; }
		}

		// Rough input token estimate for usage reporting
		const inputTokens = vsMessages.reduce((acc, m) => {
			for (const part of m.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					acc += Math.ceil(part.value.length / 4);
				}
			}
			return acc;
		}, 0);

		const cts = new vscode.CancellationTokenSource();
		_req.on('close', () => cts.cancel());

		let vsResponse: vscode.LanguageModelChatResponse;
		try {
			vsResponse = await model.sendRequest(vsMessages, options, cts.token);
		} catch (err) {
			cts.dispose();
			writeJSON(res, 500, { type: 'error', error: { type: 'api_error', message: String(err) } });
			return;
		}

		if (req.stream !== false) {
			await streamMessagesSSE(res, vsResponse, model.id, inputTokens, cts.token);
		} else {
			const result = await collectMessagesResponse(vsResponse, model.id, inputTokens, cts.token);
			writeJSON(res, 200, result);
		}

		cts.dispose();
	};
}

/** Handler for token counting endpoint. */
export function createMessagesCountTokensHandler(): RouteHandler {
	return async (_req: http.IncomingMessage, res: http.ServerResponse, body: unknown) => {
		const req = body as MessagesRequest;
		if (!req.model || !Array.isArray(req.messages)) {
			writeJSON(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'model and messages are required' } });
			return;
		}
		const models = await vscode.lm.selectChatModels({ id: req.model });
		if (models.length === 0) {
			writeJSON(res, 404, { type: 'error', error: { type: 'not_found_error', message: `Model '${req.model}' not found` } });
			return;
		}
		const model = models[0];
		const vsMessages = convertAnthropicMessagesToVSCode(req.messages, req.system);
		let total = 0;
		for (const m of vsMessages) {
			try { total += await model.countTokens(m); } catch { /* ignore */ }
		}
		writeJSON(res, 200, { input_tokens: total });
	};
}

/** Handler for GET /v1/models — returns available models in Anthropic format. */
export function createMessagesModelsHandler(): RouteHandler {
	return async (_req, res) => {
		const models = await vscode.lm.selectChatModels();
		writeJSON(res, 200, {
			data: models.map(m => ({
				type: 'model',
				id: m.id,
				display_name: m.name,
				created_at: new Date(0).toISOString(),
			})),
			has_more: false,
			first_id: models[0]?.id ?? null,
			last_id: models[models.length - 1]?.id ?? null,
		});
	};
}
