'use strict';

function applyMemoryPromptPolicy(chats, sections, hasPromptTemplate, memoryCardUsed) {
  const memories = [];
  if (!hasPromptTemplate && chats.length > 0) {
    sections.lastChat.push(chats[chats.length - 1]);
    chats.splice(chats.length - 1, 1);
  }

  sections.chats = chats
    .map((chat) => {
      if (chat.memo !== 'supaMemory' && chat.memo !== 'hypaMemory') {
        chat.removable = true;
      } else if (memoryCardUsed) {
        memories.push(chat);
        return { role: 'system', content: '' };
      } else {
        chat.content = `<Previous Conversation>${chat.content}</Previous Conversation>`;
      }
      return chat;
    })
    .filter((chat) => chat.content.trim() !== '' || Boolean(chat.multimodals?.length));

  return memories;
}

function insertDepthPrompts(sections, depthPrompts, renderPrompt) {
  for (const depthPrompt of depthPrompts) {
    const chat = {
      role: depthPrompt.role,
      content: renderPrompt(depthPrompt.prompt),
    };
    const depth =
      depthPrompt.pos === 'depth'
        ? depthPrompt.depth
        : sections.chats.length - depthPrompt.depth;
    sections.chats.splice(depth, 0, chat);
  }
}

function applyTriggerPromptPolicy(sections, triggerResult) {
  const prompts = triggerResult?.additonalSysPrompt;
  if (!prompts) return;
  if (prompts.promptend) {
    sections.postEverything.push({ role: 'system', content: prompts.promptend });
  }
  if (prompts.historyend) {
    sections.lastChat.push({ role: 'system', content: prompts.historyend });
  }
  if (prompts.start) {
    sections.lastChat.unshift({ role: 'system', content: prompts.start });
  }
}

function buildPromptBiases(biases, renderBias) {
  return biases.map(([text, weight]) => [
    renderBias(
      text
        .replaceAll('\\n', '\n')
        .replaceAll('\\r', '\r')
        .replaceAll('\\\\', '\\'),
    ),
    weight,
  ]);
}

module.exports = {
  applyMemoryPromptPolicy,
  insertDepthPrompts,
  applyTriggerPromptPolicy,
  buildPromptBiases,
};
