/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { ProxyServer } from './proxyServer';
import { createResponsesHandler, createResponsesModelsHandler } from './responsesProxy';
import { createMessagesHandler, createMessagesCountTokensHandler, createMessagesModelsHandler } from './messagesProxy';

export interface ProxyInfo {
	responsesUrl: string;
	responsesNonce: string;
	messagesUrl: string;
	messagesNonce: string;
}

/**
 * Manages two local HTTP proxy servers:
 *  - OpenAI Responses API proxy  (POST /v1/responses, GET /v1/models)
 *  - Anthropic Messages API proxy (POST /v1/messages, POST /v1/messages/count_tokens, GET /v1/models)
 *
 * Both are started on `127.0.0.1:0` and disposed when the extension deactivates.
 */
export class ProxyManager {
	private readonly _responses: ProxyServer;
	private readonly _messages: ProxyServer;

	constructor() {
		this._responses = new ProxyServer();
		this._responses.addRoute('POST', '/v1/responses', createResponsesHandler());
		this._responses.addRoute('GET', '/v1/models', createResponsesModelsHandler());
		// Also accept /responses without /v1/ prefix
		this._responses.addRoute('POST', '/responses', createResponsesHandler());
		this._responses.addRoute('GET', '/models', createResponsesModelsHandler());

		this._messages = new ProxyServer();
		this._messages.addRoute('POST', '/v1/messages', createMessagesHandler());
		this._messages.addRoute('POST', '/v1/messages/count_tokens', createMessagesCountTokensHandler());
		this._messages.addRoute('GET', '/v1/models', createMessagesModelsHandler());
		// Also accept without /v1/ prefix
		this._messages.addRoute('POST', '/messages', createMessagesHandler());
		this._messages.addRoute('POST', '/messages/count_tokens', createMessagesCountTokensHandler());
		this._messages.addRoute('GET', '/models', createMessagesModelsHandler());
	}

	async start(): Promise<ProxyInfo> {
		await Promise.all([this._responses.start(), this._messages.start()]);
		return {
			responsesUrl: this._responses.baseUrl,
			responsesNonce: this._responses.nonce,
			messagesUrl: this._messages.baseUrl,
			messagesNonce: this._messages.nonce,
		};
	}

	get info(): ProxyInfo {
		return {
			responsesUrl: this._responses.baseUrl,
			responsesNonce: this._responses.nonce,
			messagesUrl: this._messages.baseUrl,
			messagesNonce: this._messages.nonce,
		};
	}

	dispose(): void {
		this._responses.dispose();
		this._messages.dispose();
	}
}
