export type OllamaCloudTransportApi =
  "native" | "openai-chat" | "responses" | "anthropic";
("use strict");

const OLLAMA_CLOUD_TRANSPORT_URLS = Object.freeze({
  native: "https://ollama.com/api/chat",
  "openai-chat": "https://ollama.com/v1/chat/completions",
  responses: "https://ollama.com/v1/responses",
  anthropic: "https://ollama.com/v1/messages",
});

const DEFAULT_OLLAMA_CLOUD_CHAT_URL: "https://ollama.com/api/chat" =
  OLLAMA_CLOUD_TRANSPORT_URLS.native;

function resolveOllamaCloudTransportUrl(
  api: OllamaCloudTransportApi,
): string | null;
function resolveOllamaCloudTransportUrl(api?: any): any {
  return OLLAMA_CLOUD_TRANSPORT_URLS[api] ?? null;
}

export {
  DEFAULT_OLLAMA_CLOUD_CHAT_URL,
  OLLAMA_CLOUD_TRANSPORT_URLS,
  resolveOllamaCloudTransportUrl,
};
