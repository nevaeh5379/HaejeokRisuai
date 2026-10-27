import type { LLMParameter } from "../process/request/shared";
import { LLM_FORMATS } from "../../../packages/protocol/modelFormat.ts";
import { LLM_FLAGS } from "../../../packages/protocol/modelFlags.ts";

export const LLMFlags = LLM_FLAGS;
export type LLMFlags = (typeof LLMFlags)[keyof typeof LLMFlags];

export const LLMProvider = {
  OpenAI: 0,
  Anthropic: 1,
  GoogleCloud: 2,
  VertexAI: 3,
  AsIs: 4,
  Mistral: 5,
  NovelList: 6,
  Cohere: 7,
  NovelAI: 8,
  WebLLM: 9,
  Horde: 10,
  AWS: 11,
  DeepSeek: 12,
  DeepInfra: 13,
  Echo: 14,
  NanoGPT: 15,
  Ollama: 16,
} as const;
export type LLMProvider = (typeof LLMProvider)[keyof typeof LLMProvider];

export const LLMFormat = LLM_FORMATS;
export type LLMFormat = (typeof LLMFormat)[keyof typeof LLMFormat];

import { LLM_TOKENIZER } from "../../../packages/protocol/modelTokenizer.ts";
export const LLMTokenizer = LLM_TOKENIZER;
export type LLMTokenizer = (typeof LLM_TOKENIZER)[keyof typeof LLM_TOKENIZER];

export type ClaudeThinkingType = "off" | "budget" | "adaptive";

export function resolveClaudeThinkingType(
  flags: LLMFlags[],
  thinkingType: ClaudeThinkingType,
): ClaudeThinkingType {
  if (
    thinkingType === "budget" &&
    !flags.includes(LLMFlags.claudeThinking) &&
    flags.includes(LLMFlags.claudeAdaptiveThinking)
  ) {
    return "adaptive";
  }
  return thinkingType;
}

export interface LLMModel {
  id: string;
  name: string;
  shortName?: string;
  fullName?: string;
  internalID?: string;
  provider: LLMProvider;
  flags: LLMFlags[];
  format: LLMFormat;
  parameters: LLMParameter[];
  tokenizer: LLMTokenizer;
  recommended?: boolean;
  keyIdentifier?: string;
  endpoint?: string;
}

export const ProviderNames = new Map<LLMProvider, string>([
  [LLMProvider.OpenAI, "OpenAI"],
  [LLMProvider.Anthropic, "Anthropic"],
  [LLMProvider.GoogleCloud, "Google Cloud"],
  [LLMProvider.VertexAI, "Vertex AI"],
  [LLMProvider.AsIs, "As Is"],
  [LLMProvider.Mistral, "MistralAI"],
  [LLMProvider.NovelList, "NovelList"],
  [LLMProvider.Cohere, "Cohere"],
  [LLMProvider.NovelAI, "NovelAI"],
  [LLMProvider.WebLLM, "WebLLM"],
  [LLMProvider.Horde, "Horde"],
  [LLMProvider.AWS, "AWS"],
  [LLMProvider.DeepSeek, "DeepSeek"],
  [LLMProvider.DeepInfra, "DeepInfra"],
  [LLMProvider.Echo, "For Developer"],
  [LLMProvider.NanoGPT, "NanoGPT"],
  [LLMProvider.Ollama, "Ollama"],
]);

export const OpenAIParameters: LLMParameter[] = [
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
];
const GPT5BaseParameters: LLMParameter[] = [
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "reasoning_effort",
  "verbosity",
];
export const GPT5Parameters: LLMParameter[] = [...GPT5BaseParameters];
export const GPT5NoneParameters: LLMParameter[] = [
  ...GPT5BaseParameters,
  "reasoning_effort_none",
];
export const GPT5XHighParameters: LLMParameter[] = [
  ...GPT5NoneParameters,
  "reasoning_effort_xhigh",
];
export const GPT5ProParameters: LLMParameter[] = [
  ...GPT5BaseParameters,
  "reasoning_effort_min_medium",
  "reasoning_effort_xhigh",
];
export const ClaudeParameters: LLMParameter[] = [
  "temperature",
  "top_k",
  "top_p",
];
