'use strict';

const DEFAULT_NOVELLIST_API_URL = 'https://api.tringpt.com//api';

function buildNovelListRequestBody(options) {
  const biasString = options.biasString ?? [];
  const logitBias = [];
  const logitBiasValues = [];

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
    model: options.modelId === 'novellist_damsel' ? 'damsel' : 'supertrin',
    stoptokens: `「${options.sampler.stoptokens}`,
    logit_bias: logitBias.length > 0 ? logitBias.join('<<|>>') : undefined,
    logit_bias_values:
      logitBiasValues.length > 0 ? logitBiasValues.join('|') : undefined,
  };
}

module.exports = {
  DEFAULT_NOVELLIST_API_URL,
  buildNovelListRequestBody,
};
