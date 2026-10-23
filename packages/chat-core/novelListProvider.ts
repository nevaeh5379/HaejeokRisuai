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

const DEFAULT_NOVELLIST_API_URL: "https://api.tringpt.com//api" =
  "https://api.tringpt.com//api";

function buildNovelListRequestBody(
  options: NovelListRequestBodyOptions,
): NovelListRequestBody {
  const biasString = options.biasString;
  let logitBias: string | undefined;
  let logitBiasValues: string | undefined;

  if (biasString && biasString.length > 0) {
    const len = biasString.length;
    const biases: string[] = new Array(len);
    const values: string[] = new Array(len);
    for (let i = 0; i < len; i++) {
      biases[i] = biasString[i][0];
      values[i] = String(biasString[i][1]);
    }
    logitBias = biases.join("<<|>>");
    logitBiasValues = values.join("|");
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
    logit_bias: logitBias,
    logit_bias_values: logitBiasValues,
  };
}

export { DEFAULT_NOVELLIST_API_URL, buildNovelListRequestBody };
