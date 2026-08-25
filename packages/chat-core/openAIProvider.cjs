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
  collectOpenAIToolCalls,
  appendOpenAIStreamingFragment,
  mergeOpenAIStreamingToolCallDeltas,
  formatOpenAIReasoningText,
};
