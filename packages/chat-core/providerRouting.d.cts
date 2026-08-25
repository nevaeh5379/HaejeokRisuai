import type { LLMFormatValue } from "../protocol/modelFormat.cjs";

export type ProviderRoute =
  | "openai"
  | "openai-responses"
  | "openai-legacy"
  | "anthropic"
  | "google"
  | "novelai"
  | "novellist"
  | "cohere"
  | "ooba-legacy"
  | "ooba"
  | "plugin"
  | "kobold"
  | "ollama"
  | "horde"
  | "webllm"
  | "echo";

export function resolveProviderRoute(
  format: LLMFormatValue | number,
): ProviderRoute | null;
