/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as vscode from 'vscode';
import { makeId, startSSE, writeJSON, writeSSEEvent, RouteHandler } from './proxyServer';

// ---------------------------------------------------------------------------
// Minimal type shapes for OpenAI Responses API (no SDK dependency)
// ---------------------------------------------------------------------------

interface ResponsesContentPart {
	type: 'input_text' | 'output_text' | 'input_image' | 'refusal' | string;
	text?: string;
	image_url?: string;
	detail?: string;
	refusal?: string;
}

interface ResponsesMessageItem {
	type: 'message';
	role: 'user' | 'assistant' | 'system';
	content: ResponsesContentPart[];
}

interface ResponsesFunctionCallItem {
	type: 'function_call';
	call_id: string;
	name: string;
	arguments: string;
}

interface ResponsesFunctionCallOutputItem {
	type: 'function_call_output';
	call_id: string;
	output: string;
}

interface ResponsesReasoningItem {
	type: 'reasoning';
	id?: string;
	encrypted_content?: string;
}

type ResponsesInputItem =
	| ResponsesMessageItem
	| ResponsesFunctionCallItem
	| ResponsesFunctionCallOutputItem
	| ResponsesReasoningItem
	| { type: string }; // fallback for unknown types

interface ResponsesFunctionTool {
	type: 'function';
	name: string;
	description?: string;
	parameters?: object;
	strict?: boolean;
}

interface ResponsesRequest {
	model: string;
	input: ResponsesInputItem[];
	tools?: ResponsesFunctionTool[];
	stream?: boolean;
	max_output_tokens?: number;
	reasoning?: { effort?: string; summary?: string };
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Input conversion: Responses API input[] → vscode.LanguageModelChatMessage[]
// ---------------------------------------------------------------------------

function convertContentPart(part: ResponsesContentPart): vscode.LanguageModelTextPart | undefined {
	switch (part.type) {
		case 'input_text':
		case 'output_text':
			return new vscode.LanguageModelTextPart(part.text ?? '');
		case 'refusal':
			return new vscode.LanguageModelTextPart(`[Refusal] ${part.refusal ?? ''}`);
		case 'input_image':
			// Images not supported via VS Code LM API; use placeholder
			return new vscode.LanguageModelTextPart('[Image]');
		default:
			return undefined;
	}
}

export function convertInputToMessages(input: ResponsesInputItem[]): vscode.LanguageModelChatMessage[] {
	const messages: vscode.LanguageModelChatMessage[] = [];
	let i = 0;

	while (i < input.length) {
		const item = input[i];

		// Drop reasoning and unknown items
		if (item.type === 'reasoning' || (item.type !== 'message' && item.type !== 'function_call' && item.type !== 'function_call_output')) {
			i++;
			continue;
		}

		if (item.type === 'message') {
			const msg = item as ResponsesMessageItem;
			if (msg.role === 'user' || msg.role === 'system') {
				// system role has no VS Code equivalent — treat as User so it doesn't start as Assistant
				const parts = msg.content.map(convertContentPart).filter((p): p is vscode.LanguageModelTextPart => p !== undefined);
				messages.push(vscode.LanguageModelChatMessage.User(parts.length > 0 ? parts : ''));
				i++;
			} else {
				// Assistant message — collect text parts plus any immediately-following function_calls
				const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
				for (const c of msg.content) {
					const p = convertContentPart(c);
					if (p) { parts.push(p); }
				}
				i++;
				// Consume following function_call items and merge into this assistant message
				while (i < input.length && input[i].type === 'function_call') {
					const fc = input[i] as ResponsesFunctionCallItem;
					let parsedArgs: object;
					try { parsedArgs = JSON.parse(fc.arguments) as object; } catch { parsedArgs = {}; }
					parts.push(new vscode.LanguageModelToolCallPart(fc.call_id, fc.name, parsedArgs));
					i++;
				}
				messages.push(vscode.LanguageModelChatMessage.Assistant(parts.length > 0 ? parts : ''));
			}
		} else if (item.type === 'function_call') {
			// Standalone function_call(s) without a preceding assistant message
			const parts: vscode.LanguageModelToolCallPart[] = [];
			while (i < input.length && input[i].type === 'function_call') {
				const fc = input[i] as ResponsesFunctionCallItem;
				let parsedArgs: object;
				try { parsedArgs = JSON.parse(fc.arguments) as object; } catch { parsedArgs = {}; }
				parts.push(new vscode.LanguageModelToolCallPart(fc.call_id, fc.name, parsedArgs));
				i++;
			}
			messages.push(vscode.LanguageModelChatMessage.Assistant(parts));
		} else if (item.type === 'function_call_output') {
			// Tool results → user message; group consecutive outputs together
			const results: vscode.LanguageModelToolResultPart[] = [];
			while (i < input.length && input[i].type === 'function_call_output') {
				const fco = input[i] as ResponsesFunctionCallOutputItem;
				results.push(new vscode.LanguageModelToolResultPart(fco.call_id, [
					new vscode.LanguageModelTextPart(fco.output),
				]));
				i++;
			}
			messages.push(vscode.LanguageModelChatMessage.User(results));
		} else {
			i++;
		}
	}

	// VS Code LM API rejects conversations that start with an Assistant message.
	// This happens when Codex replays tool-call history at the start of the input.
	// Prepend a minimal User message to satisfy the constraint.
	if (messages.length > 0 && messages[0].role !== 1 /* User */) {
		messages.unshift(vscode.LanguageModelChatMessage.User('(continuing)'));
	}

	return messages;
}

// ---------------------------------------------------------------------------
// Tools conversion
// ---------------------------------------------------------------------------

function convertTools(tools: ResponsesFunctionTool[]): vscode.LanguageModelChatTool[] {
	return tools
		.filter(t => t.type === 'function' && t.name)
		.map(t => ({
			name: t.name,
			description: t.description ?? '',
			inputSchema: t.parameters as Record<string, unknown> ?? {},
		}));
}

// ---------------------------------------------------------------------------
// Output: VS Code stream → Responses API SSE
// ---------------------------------------------------------------------------

async function streamResponsesSSE(
	res: http.ServerResponse,
	vsResponse: vscode.LanguageModelChatResponse,
	modelId: string,
	token: vscode.CancellationToken,
): Promise<void> {
	const responseId = makeId('resp');
	const messageItemId = makeId('msg');

	const ThinkingPartCtor = (vscode as unknown as Record<string, unknown>)['LanguageModelThinkingPart'] as (new (...args: unknown[]) => unknown) | undefined;

	startSSE(res);

	// Phase 1: Setup events
	const baseResponse = { id: responseId, object: 'realtime.response', status: 'in_progress', model: modelId, output: [], usage: null };
	writeSSEEvent(res, { type: 'response.created', response: baseResponse });
	writeSSEEvent(res, { type: 'response.in_progress', response: baseResponse });

	// Open the message output item
	let outputIndex = 0;
	const msgOutputIndex = outputIndex;
	writeSSEEvent(res, {
		type: 'response.output_item.added',
		output_index: msgOutputIndex,
		item: { id: messageItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
	});

	// Open the text content part
	let contentIndex = 0;
	const textContentIndex = contentIndex;
	let textContentOpen = false;
	let accumulatedText = '';

	const openTextContent = () => {
		if (textContentOpen) { return; }
		textContentOpen = true;
		writeSSEEvent(res, {
			type: 'response.content_part.added',
			item_id: messageItemId,
			output_index: msgOutputIndex,
			content_index: textContentIndex,
			part: { type: 'output_text', text: '' },
		});
	};

	const closeTextContent = () => {
		if (!textContentOpen) { return; }
		textContentOpen = false;
		writeSSEEvent(res, {
			type: 'response.output_text.done',
			item_id: messageItemId,
			output_index: msgOutputIndex,
			content_index: textContentIndex,
			text: accumulatedText,
		});
		writeSSEEvent(res, {
			type: 'response.content_part.done',
			item_id: messageItemId,
			output_index: msgOutputIndex,
			content_index: textContentIndex,
			part: { type: 'output_text', text: accumulatedText },
		});
	};

	// Track tool call output items
	const toolCallItems: Array<{ id: string; call_id: string; name: string; arguments: string; output_index: number }> = [];
	outputIndex++; // tool calls start at outputIndex 1+

	let usageInputTokens = 0;
	let usageOutputTokens = 0;
	let stopReason = 'stop';
	let partCount = 0;

	try {
		for await (const part of vsResponse.stream) {
			if (token.isCancellationRequested) { break; }
			const partType = (part as { constructor?: { name?: string } }).constructor?.name ?? typeof part;
			const isText = part instanceof vscode.LanguageModelTextPart;
			const isToolCall = part instanceof vscode.LanguageModelToolCallPart;
			const isData = part instanceof vscode.LanguageModelDataPart;
			const isThinking = ThinkingPartCtor ? part instanceof ThinkingPartCtor : false;
			if (partCount < 5) {
				console.log(`[responses-proxy] stream part[${partCount}] type=${partType} isText=${isText} isTool=${isToolCall} isData=${isData} isThinking=${isThinking}`, isText ? (part as vscode.LanguageModelTextPart).value.slice(0, 60) : '');
			}
			partCount++;

			if (isText) {
				openTextContent();
				accumulatedText += (part as vscode.LanguageModelTextPart).value;
				writeSSEEvent(res, {
					type: 'response.output_text.delta',
					item_id: messageItemId,
					output_index: msgOutputIndex,
					content_index: textContentIndex,
					delta: (part as vscode.LanguageModelTextPart).value,
				});
			} else if (isToolCall) {
				// Close text content before emitting tool calls
				closeTextContent();
				stopReason = 'tool_calls';

				const toolPart = part as vscode.LanguageModelToolCallPart;
				const toolItemId = makeId('fc');
				const toolOutputIndex = outputIndex++;
				const argsJson = JSON.stringify(toolPart.input);

				writeSSEEvent(res, {
					type: 'response.output_item.added',
					output_index: toolOutputIndex,
					item: { id: toolItemId, type: 'function_call', status: 'in_progress', call_id: part.callId, name: part.name, arguments: '' },
				});
				writeSSEEvent(res, {
					type: 'response.function_call_arguments.delta',
					item_id: toolItemId,
					output_index: toolOutputIndex,
					delta: argsJson,
				});
				writeSSEEvent(res, {
					type: 'response.function_call_arguments.done',
					item_id: toolItemId,
					output_index: toolOutputIndex,
					arguments: argsJson,
				});
				writeSSEEvent(res, {
					type: 'response.output_item.done',
					output_index: toolOutputIndex,
					item: { id: toolItemId, type: 'function_call', status: 'completed', call_id: toolPart.callId, name: toolPart.name, arguments: argsJson },
				});

				toolCallItems.push({ id: toolItemId, call_id: toolPart.callId, name: toolPart.name, arguments: argsJson, output_index: toolOutputIndex });
			} else if (isData) {
				const dataPart = part as vscode.LanguageModelDataPart;
				// Check for usage DataPart
				if (dataPart.mimeType === 'application/vnd.vscode.lm.usage') {
					try {
						const usage = JSON.parse(new TextDecoder().decode(dataPart.data)) as { inputTokens?: number; outputTokens?: number };
						usageInputTokens = usage.inputTokens ?? usageInputTokens;
						usageOutputTokens = usage.outputTokens ?? usageOutputTokens;
					} catch { /* ignore */ }
				}
			} else if (isThinking) {
				// Thinking parts dropped — codex manages its own reasoning state
			}
		}
	} catch (streamErr) {
		console.error('[responses-proxy] stream error:', streamErr);
	}
	console.log(`[responses-proxy] stream iteration done, total parts=${partCount ?? 0}`);

	// Phase 3: Close message item
	closeTextContent();

	const outputContent = accumulatedText
		? [{ type: 'output_text', text: accumulatedText, annotations: [] }]
		: [];

	writeSSEEvent(res, {
		type: 'response.output_item.done',
		output_index: msgOutputIndex,
		item: { id: messageItemId, type: 'message', status: 'completed', role: 'assistant', content: outputContent },
	});

	// Final response.completed
	const finalOutput: unknown[] = [];
	if (accumulatedText) {
		finalOutput.push({ id: messageItemId, type: 'message', status: 'completed', role: 'assistant', content: outputContent });
	}
	for (const tc of toolCallItems) {
		finalOutput.push({ id: tc.id, type: 'function_call', status: 'completed', call_id: tc.call_id, name: tc.name, arguments: tc.arguments });
	}

	writeSSEEvent(res, {
		type: 'response.completed',
		response: {
			id: responseId,
			object: 'realtime.response',
			status: 'completed',
			model: modelId,
			output: finalOutput,
			usage: {
				input_tokens: usageInputTokens,
				output_tokens: usageOutputTokens,
				total_tokens: usageInputTokens + usageOutputTokens,
				output_tokens_details: { reasoning_tokens: 0 },
			},
		},
	});
	console.log(`[responses-proxy] stream done — in=${usageInputTokens} out=${usageOutputTokens} total=${usageInputTokens + usageOutputTokens}`);
	res.end();
}

// ---------------------------------------------------------------------------
// Non-streaming response
// ---------------------------------------------------------------------------

async function collectResponsesResponse(
	vsResponse: vscode.LanguageModelChatResponse,
	modelId: string,
	token: vscode.CancellationToken,
): Promise<object> {
	const responseId = makeId('resp');
	const messageItemId = makeId('msg');
	let text = '';
	const toolCalls: Array<{ id: string; call_id: string; name: string; arguments: string }> = [];

	try {
		for await (const part of vsResponse.stream) {
			if (token.isCancellationRequested) { break; }
			if (part instanceof vscode.LanguageModelTextPart) {
				text += part.value;
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({ id: makeId('fc'), call_id: part.callId, name: part.name, arguments: JSON.stringify(part.input) });
			}
		}
	} catch { /* ignore */ }

	const output: unknown[] = [];
	const content: unknown[] = [];
	if (text) { content.push({ type: 'output_text', text, annotations: [] }); }

	if (content.length > 0) {
		output.push({ id: messageItemId, type: 'message', status: 'completed', role: 'assistant', content });
	}
	for (const tc of toolCalls) {
		output.push({ id: tc.id, type: 'function_call', status: 'completed', call_id: tc.call_id, name: tc.name, arguments: tc.arguments });
	}

	return {
		id: responseId,
		object: 'realtime.response',
		status: 'completed',
		model: modelId,
		output,
		usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
	};
}

// ---------------------------------------------------------------------------
// Main handler factory
// ---------------------------------------------------------------------------

export function createResponsesHandler(): RouteHandler {
	return async (_req: http.IncomingMessage, res: http.ServerResponse, body: unknown) => {
		const req = body as ResponsesRequest;
		console.log(`[responses-proxy] → POST /v1/responses model=${req.model} stream=${req.stream !== false} tools=${Array.isArray(req.tools) ? req.tools.length : 0} input=${Array.isArray(req.input) ? req.input.length : '?'}`);
		if (!req.model) {
			writeJSON(res, 400, { error: { type: 'invalid_request_error', message: '`model` field is required' } });
			return;
		}
		if (!Array.isArray(req.input) || req.input.length === 0) {
			writeJSON(res, 400, { error: { type: 'invalid_request_error', message: '`input` array is required and must not be empty' } });
			return;
		}

		// Model lookup — consumer provides exact ID; prefer copilot vendor when multiple matches
		const models = await vscode.lm.selectChatModels({ id: req.model });
		console.log(`[responses-proxy] model lookup '${req.model}' → ${models.length} match(es)${models.length ? ': ' + models.map(m => `${m.vendor}/${m.id}`).join(', ') : ''}`);
		if (models.length === 0) {
			writeJSON(res, 404, { error: { type: 'not_found_error', message: `Model '${req.model}' not found` } });
			return;
		}
		// Prefer copilot-vendor model; fall back to first match
		const model = models.find(m => m.vendor === 'copilot') ?? models[0];

		const messages = convertInputToMessages(req.input);
		if (messages.length === 0) {
			writeJSON(res, 400, { error: { type: 'invalid_request_error', message: 'No messages could be derived from `input`' } });
			return;
		}

		const options: vscode.LanguageModelChatRequestOptions = {};
		if (Array.isArray(req.tools) && req.tools.length > 0) {
			const fns = req.tools.filter(t => t.type === 'function');
			console.log(`[responses-proxy] tools[0] sample:`, JSON.stringify(fns[0]).slice(0, 300));
			options.tools = convertTools(fns);
		}

		const cts = new vscode.CancellationTokenSource();
		_req.on('close', () => cts.cancel());

		let vsResponse: vscode.LanguageModelChatResponse;
		try {
			console.log(`[responses-proxy] sendRequest model=${model.id} messages=${messages.length} firstRole=${messages[0]?.role}`);
			vsResponse = await model.sendRequest(messages, options, cts.token);
		} catch (err) {
			console.error(`[responses-proxy] sendRequest error:`, err);
			cts.dispose();
			writeJSON(res, 500, { error: { type: 'server_error', message: String(err) } });
			return;
		}

		if (req.stream !== false) {
			await streamResponsesSSE(res, vsResponse, model.id, cts.token);
		} else {
			const result = await collectResponsesResponse(vsResponse, model.id, cts.token);
			writeJSON(res, 200, result);
		}

		cts.dispose();
	};
}

/** Handler for GET /v1/models — returns available models in OpenAI format. */
export function createResponsesModelsHandler(): RouteHandler {
	return async (_req, res) => {
		const models = await vscode.lm.selectChatModels();
		writeJSON(res, 200, {
			object: 'list',
			data: models.map(m => ({
				id: m.id,
				object: 'model',
				created: 0,
				owned_by: m.vendor,
			})),
		});
	};
}
