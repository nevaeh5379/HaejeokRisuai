export type NovelAIVariant = "kayra" | "clio";

export const NOVELAI_GENERATE_URLS: Readonly<Record<NovelAIVariant, string>>;
export const NOVELAI_BAD_WORD_IDS: readonly (readonly number[])[];
export const NOVELAI_REPETITION_PENALTY_WHITELIST: readonly number[];

export interface NovelAIGenerationSettings {
  topK: number;
  topP: number;
  topA: number;
  tailFreeSampling: number;
  repetitionPenalty: number;
  repetitionPenaltyRange: number;
  repetitionPenaltySlope: number;
  frequencyPenalty: number;
  presencePenalty: number;
  typicalp: number;
  mirostat_lr?: number;
  mirostat_tau?: number;
  cfg_scale?: number;
}

export interface NovelAILogitBiasEntry {
  sequence: number[];
  bias: number;
  ensure_sequence_finish: false;
  generate_once: true;
}

export interface NovelAIRequestOptions {
  prompt: string;
  modelId: string;
  adventureMode: boolean;
  temperature?: number;
  maxTokens?: number;
  settings: NovelAIGenerationSettings;
  logitBiasExp?: readonly NovelAILogitBiasEntry[];
}

export interface NovelAIRequestBody {
  input: string;
  model: "kayra-v1" | "clio-v1";
  parameters: Record<string, unknown>;
}

export function resolveNovelAIGenerateUrl(variant: string): string | null;
export function buildNovelAIRequest(options: NovelAIRequestOptions): {
  variant: NovelAIVariant;
  body: NovelAIRequestBody;
};
