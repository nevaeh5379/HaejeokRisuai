export type OllamaCloudTransportApi =
  "native" | "openai-chat" | "responses" | "anthropic";

export const DEFAULT_OLLAMA_CLOUD_CHAT_URL: "https://ollama.com/api/chat";
export const OLLAMA_CLOUD_TRANSPORT_URLS: Readonly<
  Record<OllamaCloudTransportApi, string>
>;
export function resolveOllamaCloudTransportUrl(
  api: OllamaCloudTransportApi,
): string | null;
