'use strict';

const OLLAMA_CLOUD_TRANSPORT_URLS = Object.freeze({
  native: 'https://ollama.com/api/chat',
  'openai-chat': 'https://ollama.com/v1/chat/completions',
  responses: 'https://ollama.com/v1/responses',
  anthropic: 'https://ollama.com/v1/messages',
});

const DEFAULT_OLLAMA_CLOUD_CHAT_URL = OLLAMA_CLOUD_TRANSPORT_URLS.native;

function resolveOllamaCloudTransportUrl(api) {
  return OLLAMA_CLOUD_TRANSPORT_URLS[api] ?? null;
}

module.exports = {
  DEFAULT_OLLAMA_CLOUD_CHAT_URL,
  OLLAMA_CLOUD_TRANSPORT_URLS,
  resolveOllamaCloudTransportUrl,
};
