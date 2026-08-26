'use strict';

const GOOGLE_GENERATIVE_LANGUAGE_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/models';

function buildGoogleGenerateContentUrl(modelId, apiKey) {
  return `${GOOGLE_GENERATIVE_LANGUAGE_BASE_URL}/${modelId}:generateContent?key=${apiKey}`;
}

function prepareGoogleConversation(messages, options = {}) {
  const chats = [];
  let systemPrompt = '';
  let startIndex = 0;

  if (messages[0]?.role === 'system') {
    systemPrompt = messages[0].content;
    startIndex = 1;
  }

  for (let index = startIndex; index < messages.length; index++) {
    const chat = messages[index];
    const previous = chats[chats.length - 1];

    if (chat.multimodals?.length) {
      const parts = [{ text: chat.content }];
      for (const modal of chat.multimodals) {
        const supported =
          (modal.type === 'image' && options.hasImageInput) ||
          (modal.type === 'audio' && options.hasAudioInput) ||
          (modal.type === 'video' && options.hasVideoInput);
        if (supported) {
          const dataurl = modal.base64;
          const base64 = dataurl.split(',')[1];
          const mediaType = dataurl.split(';')[0].split(':')[1];
          parts.push({ inlineData: { mimeType: mediaType, data: base64 } });
          continue;
        }
        if (modal.type === 'signature' && options.resolveSignature) {
          const signaturePart = options.resolveSignature(modal);
          if (signaturePart) parts.push(signaturePart);
        }
      }
      chats.push({
        role: chat.role === 'user' ? 'user' : 'model',
        parts,
      });
      continue;
    }

    if (chat.role === 'system') {
      if (previous?.role === 'user') {
        previous.parts[0].text += `
system:${chat.content}`;
      } else {
        chats.push({
          role: 'user',
          parts: [{ text: `${chat.role}:${chat.content}` }],
        });
      }
      continue;
    }

    if (chat.role === 'assistant' || chat.role === 'user') {
      chats.push({
        role: chat.role === 'user' ? 'user' : 'model',
        parts: [{ text: chat.content }],
      });
      continue;
    }

    chats.push({
      role: 'user',
      parts: [{ text: `${chat.role}:${chat.content}` }],
    });
  }

  return {
    chats,
    systemPrompt,
    consumedLeadingSystem: startIndex === 1,
  };
}

module.exports = {
  GOOGLE_GENERATIVE_LANGUAGE_BASE_URL,
  buildGoogleGenerateContentUrl,
  prepareGoogleConversation,
};
