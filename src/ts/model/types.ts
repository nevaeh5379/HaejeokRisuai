import type { LLMParameter } from "../process/request/shared";
import { LLM_FORMATS } from "@risuai/protocol/modelFormat.cjs";
import { LLM_FLAGS } from "@risuai/protocol/modelFlags.cjs";

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

export const LLMTokenizer = {
  Unknown: 0,
  tiktokenCl100kBase: 1,
  tiktokenO200Base: 2,
  Mistral: 3,
  Llama: 4,
  NovelAI: 5,
  Claude: 6,
  NovelList: 7,
  Llama3: 8,
  Gemma: 9,
  GoogleCloud: 10,
  Cohere: 11,
  Local: 12,
  DeepSeek: 13,
  DeepSeekV4: 14,
  GLM4: 15,
  GLM5: 16,
} as const;
export type LLMTokenizer = (typeof LLMTokenizer)[keyof typeof LLMTokenizer];

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
