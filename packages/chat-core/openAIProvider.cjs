'use strict';

const DEFAULT_OPENAI_CHAT_COMPLETIONS_URL =
  'https://api.openai.com/v1/chat/completions';

function collectOpenAIToolCalls(data) {
  const collected = [];
  const choices = Array.isArray(data?.choices) ? data.choices : [];
  for (const choice of choices) {
    const toolCalls = choice?.message?.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      collected.push(...toolCalls);
    }
  }
  return collected;
}

function appendOpenAIStreamingFragment(current, incoming) {
  if (!incoming) return current;
  if (incoming.length > current.length && incoming.startsWith(current)) {
    return incoming;
  }
  return current + incoming;
}

function mergeOpenAIStreamingToolCallDeltas(current, deltas) {
  const merged = current && typeof current === 'object' ? current : {};
  if (!Array.isArray(deltas)) return merged;
  for (const toolCall of deltas) {
    const index = toolCall?.index ?? 0;
    if (!merged[index]) {
      merged[index] = {
        id: toolCall?.id || null,
        type: 'function',
        function: { name: null, arguments: '' },
      };
    }
    if (toolCall?.id) merged[index].id = toolCall.id;
    if (toolCall?.function?.name) merged[index].function.name = toolCall.function.name;
    if (toolCall?.function?.arguments) {
      merged[index].function.arguments = appendOpenAIStreamingFragment(
        merged[index].function.arguments,
        toolCall.function.arguments,
      );
    }
  }
  return merged;
}

const OPENAI_MODEL_ALIASES = Object.freeze({
  gpt35: 'gpt-3.5-turbo',
  gpt35_0613: 'gpt-3.5-turbo-0613',
  gpt35_16k: 'gpt-3.5-turbo-16k',
  gpt35_16k_0613: 'gpt-3.5-turbo-16k-0613',
  gpt4: 'gpt-4',
  gpt45: 'gpt-4.5-preview',
  gpt4_32k: 'gpt-4-32k',
  gpt4_0613: 'gpt-4-0613',
  gpt4_32k_0613: 'gpt-4-32k-0613',
  gpt4_1106: 'gpt-4-1106-preview',
  gpt4_0125: 'gpt-4-0125-preview',
  gptvi4_1106: 'gpt-4-vision-preview',
  gpt35_0125: 'gpt-3.5-turbo-0125',
  gpt35_1106: 'gpt-3.5-turbo-1106',
  gpt35_0301: 'gpt-3.5-turbo-0301',
  gpt4_0314: 'gpt-4-0314',
  gpt4_turbo_20240409: 'gpt-4-turbo-2024-04-09',
  gpt4_turbo: 'gpt-4-turbo',
  gpt4o: 'gpt-4o',
  'gpt4o-2024-05-13': 'gpt-4o-2024-05-13',
  gpt4om: 'gpt-4o-mini',
  'gpt4om-2024-07-18': 'gpt-4o-mini-2024-07-18',
  'gpt4o-2024-08-06': 'gpt-4o-2024-08-06',
  'gpt4o-2024-11-20': 'gpt-4o-2024-11-20',
  'gpt4o-chatgpt': 'chatgpt-4o-latest',
  'gpt4o1-preview': 'o1-preview',
  'gpt4o1-mini': 'o1-mini',
});

function normalizeOpenAIProviderMessages(messages, options = {}) {
  let normalized = Array.isArray(messages) ? messages : [];
  const oobaSystemPrompts = [];
  for (let i = 0; i < normalized.length; i++) {
    const message = normalized[i];
    if (message.role !== 'function') {
      if (!(message.name && message.name.startsWith('example_') && options.newOAIHandle)) {
        message.name = undefined;
      }
      if (options.newOAIHandle && message.memo?.startsWith('NewChat')) {
        message.content = '';
      }
      if (options.deepSeekPrefix && i === normalized.length - 1 && message.role === 'assistant') {
        message.prefix = true;
      }
      if (
        options.deepSeekThinkingInput &&
        i === normalized.length - 1 &&
        Array.isArray(message.thoughts) &&
        message.thoughts.length > 0 &&
        message.role === 'assistant'
      ) {
        message.reasoning_content = message.thoughts.join('\n');
      }
      delete message.memo;
      delete message.removable;
      delete message.attr;
      delete message.multimodals;
      delete message.thoughts;
      delete message.cachePoint;
    }
    if (options.reverseProxyOobaMode && message.role === 'system') {
      if (typeof message.content === 'string') {
        oobaSystemPrompts.push(message.content);
        message.content = '';
      }
    }
  }
  if (oobaSystemPrompts.length > 0) {
    normalized.push({ role: 'system', content: oobaSystemPrompts.join('\n') });
  }
  if (options.newOAIHandle) {
    normalized = normalized.filter((message) => (
      message.content !== '' ||
      (message.multimodals && message.multimodals.length > 0) ||
      message.tool_calls ||
      message.role === 'tool'
    ));
  }
  if (options.developerRole) {
    normalized = normalized.map((message) => {
      if (message.role === 'system') message.role = 'developer';
      return message;
    });
  }
  return normalized;
}

function resolveOpenAIRequestModel(options = {}) {
  if (options.aiModel === 'nanogpt') return options.nanoGPTRequestModel;
  if (options.aiModel === 'openrouter') return options.openRouterRequestModel;
  if (OPENAI_MODEL_ALIASES[options.requestModel]) {
    return OPENAI_MODEL_ALIASES[options.requestModel];
  }
  return options.internalID || options.requestModel || 'gpt-3.5-turbo';
}

function shouldUseOpenAIFlexProcessing(options = {}) {
  if (options.isOpenAIProvider) return true;
  const isCustomEndpoint =
    options.aiModel === 'reverse_proxy' || options.aiModel?.startsWith('xcustom:::');
  if (!isCustomEndpoint) return false;
  try {
    return new URL(options.url).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

function resolveOpenAIRequestEndpoint(options = {}) {
  let url = options.aiModel === 'nanogpt'
    ? options.nanoGPTUseSubscriptionEndpoint
      ? 'https://nano-gpt.com/api/subscription/v1/chat/completions'
      : 'https://nano-gpt.com/api/v1/chat/completions'
    : options.aiModel === 'openrouter'
      ? 'https://openrouter.ai/api/v1/chat/completions'
      : (options.customURL || DEFAULT_OPENAI_CHAT_COMPLETIONS_URL);
  if (options.modelEndpoint) url = options.modelEndpoint;

  let risuIdentify = false;
  if (url.startsWith('risu::')) {
    risuIdentify = true;
    url = url.slice('risu::'.length);
  }
  if (options.aiModel === 'reverse_proxy' && options.autofillRequestUrl) {
    if (url.endsWith('v1')) url += '/chat/completions';
    else if (url.endsWith('v1/')) url += 'chat/completions';
    else if (!(url.endsWith('completions') || url.endsWith('completions/'))) {
      url += url.endsWith('/') ? 'v1/chat/completions' : '/v1/chat/completions';
    }
  }
  return { url, risuIdentify };
}

function buildOpenAIRequestHeaders(options = {}) {
  const providerKey = options.aiModel === 'nanogpt'
    ? options.nanoGPTKey
    : options.aiModel === 'reverse_proxy'
      ? options.proxyKey
      : options.aiModel === 'openrouter'
        ? options.openRouterKey
        : options.openAIKey;
  const selectedKey = options.keyIdentifier && options.keyByIdentifier
    ? options.keyByIdentifier[options.keyIdentifier]
    : (options.key ?? providerKey);
  const headers = {
    Authorization: `Bearer ${selectedKey ?? ''}`,
    'Content-Type': 'application/json',
  };
  if (options.aiModel === 'openrouter') {
    headers['X-Title'] = 'RisuAI';
    headers['HTTP-Referer'] = 'https://risuai.xyz';
  }
  if (options.aiModel === 'nanogpt' && options.nanoGPTProvider) {
    headers['X-Provider'] = options.nanoGPTProvider;
  }
  if (options.risuIdentify) headers['X-Proxy-Risu'] = 'RisuAI';
  return headers;
}

function applyOpenAIPreParameterBodyPolicies(body, options = {}) {
  if (body.logit_bias && Object.keys(body.logit_bias).length === 0) {
    delete body.logit_bias;
  }
  if (options.useCompletionTokens) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  }
  if (options.generationSeed > 0) body.seed = options.generationSeed;
  if (options.responseJsonSchema !== undefined) {
    body.response_format = {
      type: 'json_schema',
      json_schema: options.responseJsonSchema,
    };
  }
  if (options.prediction) {
    body.prediction = { type: 'content', content: options.prediction };
  }
  if (options.aiModel === 'openrouter') {
    if (options.openRouterFallback) body.route = 'fallback';
    body.transforms = options.openRouterMiddleOut ? ['middle-out'] : [];
    const configuredProvider = options.openRouterProvider;
    if (configuredProvider && typeof configuredProvider === 'object') {
      const provider = {};
      if (configuredProvider.order?.length) provider.order = configuredProvider.order;
      if (configuredProvider.only?.length) provider.only = configuredProvider.only;
      if (configuredProvider.ignore?.length) provider.ignore = configuredProvider.ignore;
      if (Object.keys(provider).length) body.provider = provider;
    }
    if (options.instructPrompt !== undefined) {
      delete body.messages;
      body.prompt = options.instructPrompt;
    }
  }
  return body;
}

function applyOpenAIPostParameterBodyPolicies(body, options = {}) {
  if (options.deepSeekThinkingToggle) {
    if (options.deepSeekThinkingType === 'enabled') {
      body.thinking = {
        type: 'enabled',
        reasoning_effort: options.deepSeekReasoningEffort ?? 'high',
      };
      delete body.temperature;
      delete body.top_p;
      delete body.frequency_penalty;
      delete body.presence_penalty;
    } else {
      body.thinking = { type: 'disabled' };
    }
  }
  if (Array.isArray(options.toolDefinitions) && options.toolDefinitions.length > 0) {
    body.tools = options.toolDefinitions;
  }
  if (options.reverseProxyOobaMode && options.reverseProxyOobaArgs) {
    for (const [key, value] of Object.entries(options.reverseProxyOobaArgs)) {
      if (value !== undefined && value !== null) body[key] = value;
    }
  }
  if (options.removeLogitBiasForInlay) delete body.logit_bias;
  if (options.multiGen) {
    if (options.hasTools) {
      return {
        body,
        error: 'MultiGen mode cannot be used with tool calls. Please disable one of them.',
      };
    }
    body.n = options.genTime;
  }
  return { body, error: null };
}

function formatOpenAIReasoningText(data, options = {}) {
  const message = data?.choices?.[0]?.message;
  let result = typeof message?.content === 'string' ? message.content : '';
  const reasoningContentField =
    data?.choices?.[0]?.reasoning_content ?? message?.reasoning_content;

  if (options.deepSeekThinkingOutput && !reasoningContentField) {
    let reasoningContent = '';
    result = result.replace(/(.*)<\/think>/gms, (_match, prefix) => {
      reasoningContent = prefix;
      return '';
    });
    if (reasoningContent) {
      reasoningContent = reasoningContent.replace(/<think>/gms, '');
      result = `<Thoughts>\n${reasoningContent}\n</Thoughts>\n${result}`;
    }
  }
  if (reasoningContentField && !result.startsWith('<Thoughts>')) {
    result = `<Thoughts>\n${reasoningContentField}\n</Thoughts>\n${result}`;
  }
  const openRouterReasoning = message?.reasoning;
  if (openRouterReasoning) {
    result = `<Thoughts>\n${openRouterReasoning}\n</Thoughts>\n${result}`;
  }
  return result;
}

module.exports = {
  DEFAULT_OPENAI_CHAT_COMPLETIONS_URL,
  OPENAI_MODEL_ALIASES,
  applyOpenAIPostParameterBodyPolicies,
  applyOpenAIPreParameterBodyPolicies,
  appendOpenAIStreamingFragment,
  buildOpenAIRequestHeaders,
  collectOpenAIToolCalls,
  formatOpenAIReasoningText,
  mergeOpenAIStreamingToolCallDeltas,
  normalizeOpenAIProviderMessages,
  resolveOpenAIRequestEndpoint,
  resolveOpenAIRequestModel,
  shouldUseOpenAIFlexProcessing,
};
