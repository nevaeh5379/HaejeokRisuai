'use strict';

const NOVELAI_GENERATE_URLS = Object.freeze({
  kayra: 'https://text.novelai.net/ai/generate',
  clio: 'https://api.novelai.net/ai/generate',
});

function resolveNovelAIGenerateUrl(variant) {
  return NOVELAI_GENERATE_URLS[variant] ?? null;
}

module.exports = { NOVELAI_GENERATE_URLS, resolveNovelAIGenerateUrl };
