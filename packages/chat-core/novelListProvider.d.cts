export const DEFAULT_NOVELLIST_API_URL: "https://api.tringpt.com//api";

export interface NovelListSamplerSettings {
  top_p: number;
  top_k: number;
  rep_pen: number;
  top_a: number;
  rep_pen_slope: number;
  rep_pen_range: number;
  typical_p: number;
  badwords: string;
  stoptokens: string;
}

export interface NovelListRequestBodyOptions {
  text: string;
  maxTokens: number;
  temperature: number;
  sampler: NovelListSamplerSettings;
  modelId: string;
  biasString?: readonly (readonly [string, number])[];
}

export interface NovelListRequestBody {
  text: string;
  length: number;
  temperature: number;
  top_p: number;
  top_k: number;
  rep_pen: number;
  top_a: number;
  rep_pen_slope: number;
  rep_pen_range: number;
  typical_p: number;
  badwords: string;
  model: "damsel" | "supertrin";
  stoptokens: string;
  logit_bias?: string;
  logit_bias_values?: string;
}

export function buildNovelListRequestBody(
  options: NovelListRequestBodyOptions,
): NovelListRequestBody;
