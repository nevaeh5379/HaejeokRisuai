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
("use strict");

const DEFAULT_NOVELLIST_API_URL: "https://api.tringpt.com//api" =
  "https://api.tringpt.com//api";

function buildNovelListRequestBody(
  options: NovelListRequestBodyOptions,
): NovelListRequestBody;
function buildNovelListRequestBody(options?: any): any {
  const biasString: any = options.biasString ?? [];
  const logitBias: any = [];
  const logitBiasValues: any = [];

  for (const bias of biasString) {
    logitBias.push(bias[0]);
    logitBiasValues.push(String(bias[1]));
  }

  return {
    text: options.text,
    length: options.maxTokens,
    temperature: options.temperature,
    top_p: options.sampler.top_p,
    top_k: options.sampler.top_k,
    rep_pen: options.sampler.rep_pen,
    top_a: options.sampler.top_a,
    rep_pen_slope: options.sampler.rep_pen_slope,
    rep_pen_range: options.sampler.rep_pen_range,
    typical_p: options.sampler.typical_p,
    badwords: options.sampler.badwords,
    model: options.modelId === "novellist_damsel" ? "damsel" : "supertrin",
    stoptokens: `「${options.sampler.stoptokens}`,
    logit_bias: logitBias.length > 0 ? logitBias.join("<<|>>") : undefined,
    logit_bias_values:
      logitBiasValues.length > 0 ? logitBiasValues.join("|") : undefined,
  };
}

export { DEFAULT_NOVELLIST_API_URL, buildNovelListRequestBody };
