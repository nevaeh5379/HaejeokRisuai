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
  formatOpenAIReasoningText,
};
