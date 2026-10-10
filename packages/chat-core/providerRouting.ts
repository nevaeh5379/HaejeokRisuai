import type { LLMFormatValue } from "../protocol/modelFormat.ts";

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
("use strict");

import { LLM_FORMATS } from "../protocol/modelFormat.ts";

const ROUTE_BY_FORMAT: any = new Map([
  [LLM_FORMATS.OpenAICompatible, "openai"],
  [LLM_FORMATS.Mistral, "openai"],
  [LLM_FORMATS.NanoGPT, "openai"],
  [LLM_FORMATS.OpenAIResponseAPI, "openai-responses"],
  [LLM_FORMATS.NanoGPTResponses, "openai-responses"],
  [LLM_FORMATS.OpenAILegacyInstruct, "openai-legacy"],
  [LLM_FORMATS.NanoGPTLegacy, "openai-legacy"],
  [LLM_FORMATS.Anthropic, "anthropic"],
  [LLM_FORMATS.AnthropicLegacy, "anthropic"],
  [LLM_FORMATS.AWSBedrockClaude, "anthropic"],
  [LLM_FORMATS.NanoGPTMessages, "anthropic"],
  [LLM_FORMATS.GoogleCloud, "google"],
  [LLM_FORMATS.VertexAIGemini, "google"],
  [LLM_FORMATS.NovelAI, "novelai"],
  [LLM_FORMATS.NovelList, "novellist"],
  [LLM_FORMATS.Cohere, "cohere"],
  [LLM_FORMATS.OobaLegacy, "ooba-legacy"],
  [LLM_FORMATS.Ooba, "ooba"],
  [LLM_FORMATS.Plugin, "plugin"],
  [LLM_FORMATS.Kobold, "kobold"],
  [LLM_FORMATS.Ollama, "ollama"],
  [LLM_FORMATS.Horde, "horde"],
  [LLM_FORMATS.WebLLM, "webllm"],
  [LLM_FORMATS.Echo, "echo"],
]);

function resolveProviderRoute(
  format: LLMFormatValue | number,
): ProviderRoute | null;
function resolveProviderRoute(format?: any): any {
  return ROUTE_BY_FORMAT.get(format) || null;
}

export { resolveProviderRoute };
