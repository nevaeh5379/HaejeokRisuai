'use strict';

const DEFAULT_ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_NO_INPUT_ERROR = 'No input';

function createCacheControl(oneHourCaching) {
  return oneHourCaching
    ? { type: 'ephemeral', ttl: '1h' }
    : { type: 'ephemeral' };
}

function prepareAnthropicConversation(messages, options = {}) {
  const claudeChat = [];
  let systemPrompt = '';
  const oneHourCaching = Boolean(options.oneHourCaching);

  function addClaudeChat(chat, multimodals) {
    if (claudeChat.length > 0 && claudeChat[claudeChat.length - 1].role === chat.role) {
      const content = claudeChat[claudeChat.length - 1].content;
      const lastContent = content[content.length - 1];
      if (lastContent?.type === 'text') {
        lastContent.text += `

${chat.content}`;
      } else {
        content.push({ type: 'text', text: chat.content });
      }

      if (multimodals?.length) {
        for (const modal of multimodals) {
          if (modal.type !== 'image') continue;
          const dataurl = modal.base64;
          const base64 = dataurl.split(',')[1];
          const mediaType = dataurl.split(';')[0].split(':')[1];
          content.unshift({
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 },
          });
        }
      }

      if (chat.cache) {
        content[content.length - 1].cache_control = createCacheControl(oneHourCaching);
      }
      return;
    }

    const content = [{ type: 'text', text: chat.content }];
    if (multimodals?.length) {
      for (const modal of multimodals) {
        if (modal.type !== 'image') continue;
        const dataurl = modal.base64;
        const base64 = dataurl.split(',')[1];
        const mediaType = dataurl.split(';')[0].split(':')[1];
        content.unshift({
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        });
      }
    }
    if (chat.cache) {
      content[0].cache_control = createCacheControl(oneHourCaching);
    }
    claudeChat.push({ role: chat.role, content });
  }

  for (const chat of messages) {
    switch (chat.role) {
      case 'user':
      case 'assistant':
        addClaudeChat(
          { role: chat.role, content: chat.content, cache: chat.cachePoint },
          chat.multimodals,
        );
        break;
      case 'system':
        if (claudeChat.length === 0) {
          systemPrompt += `

${chat.content}`;
        } else {
          addClaudeChat({
            role: 'user',
            content: `System: ${chat.content}`,
            cache: chat.cachePoint,
          });
        }
        break;
      case 'function':
        break;
    }
  }

  if (claudeChat.length === 0 && systemPrompt === '') {
    return { ok: false, error: ANTHROPIC_NO_INPUT_ERROR };
  }
  if (claudeChat.length === 0 && systemPrompt !== '') {
    claudeChat.push({ role: 'user', content: [{ type: 'text', text: 'Start' }] });
    systemPrompt = '';
  }
  if (claudeChat[0].role !== 'user') {
    claudeChat.unshift({ role: 'user', content: [{ type: 'text', text: 'Start' }] });
  }

  return { ok: true, messages: claudeChat, systemPrompt };
}

module.exports = {
  DEFAULT_ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_NO_INPUT_ERROR,
  prepareAnthropicConversation,
};
