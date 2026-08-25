'use strict';

const { TOKENIZER_ENCODINGS } = require('./compute.cjs');
const VALID_ENCODINGS = new Set(TOKENIZER_ENCODINGS);
const VALID_ROLES = new Set(['system', 'user', 'assistant', 'function']);

function finiteInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    return { error: `${name} must be an integer from ${min} to ${max}` };
  }
  return { value };
}

function normalizeChatMessage(message, index) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { error: `formated[${index}] must be an object` };
  }
  if (!VALID_ROLES.has(message.role) || typeof message.content !== 'string') {
    return { error: `formated[${index}] has an invalid role or content` };
  }
  if (message.name != null && typeof message.name !== 'string') {
    return { error: `formated[${index}].name must be a string` };
  }
  if (message.thoughts != null && (!Array.isArray(message.thoughts) || message.thoughts.some((v) => typeof v !== 'string'))) {
    return { error: `formated[${index}].thoughts must be an array of strings` };
  }
  if (message.multimodals != null && !Array.isArray(message.multimodals)) {
    return { error: `formated[${index}].multimodals must be an array` };
  }
  return { value: message };
}

function normalizeChatPlanRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Request body must be an object' };
  if (!Array.isArray(input.formated)) return { error: 'formated must be an array' };
  if (input.formated.length > 4096) return { error: 'formated may contain at most 4096 messages' };

  const messages = [];
  for (let index = 0; index < input.formated.length; index++) {
    const normalized = normalizeChatMessage(input.formated[index], index);
    if (normalized.error) return normalized;
    messages.push(normalized.value);
  }

  const maxContext = finiteInteger(input.maxContextTokens, 'maxContextTokens', { min: 1, max: 10_000_000 });
  if (maxContext.error) return maxContext;
  const maxResponse = finiteInteger(input.maxResponseTokens, 'maxResponseTokens', { min: 0, max: 10_000_000 });
  if (maxResponse.error) return maxResponse;
  const additional = finiteInteger(input.chatAdditionalTokens, 'chatAdditionalTokens', { min: 0, max: 1024 });
  if (additional.error) return additional;
  if (!VALID_ENCODINGS.has(input.encoding)) return { error: 'encoding is not supported' };

  return {
    value: {
      formated: messages,
      maxContextTokens: maxContext.value,
      maxResponseTokens: maxResponse.value,
      chatAdditionalTokens: additional.value,
      encoding: input.encoding,
      useName: input.useName === true,
      countThoughts: input.countThoughts === true,
      supportsInlayImage: input.supportsInlayImage === true,
      visionQuality: typeof input.visionQuality === 'string' ? input.visionQuality : 'high',
      model: typeof input.model === 'string' ? input.model.slice(0, 512) : '',
    },
  };
}

module.exports = { normalizeChatPlanRequest };
