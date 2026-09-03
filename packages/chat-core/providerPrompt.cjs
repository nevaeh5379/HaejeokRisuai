"use strict";

const { LLM_FLAGS } = require("../protocol/modelFlags.cjs");

function cloneMessage(message) {
  return {
    ...message,
    multimodals: message.multimodals ? [...message.multimodals] : undefined,
    thoughts: message.thoughts ? [...message.thoughts] : undefined,
  };
}

function mergeMessage(target, source) {
  target.content += `\n${source.content}`;
  if (source.multimodals?.length) {
    target.multimodals ||= [];
    target.multimodals.push(...source.multimodals);
  }
  if (source.thoughts?.length) {
    target.thoughts ||= [];
    target.thoughts.push(...source.thoughts);
  }
  if (source.cachePoint) target.cachePoint = true;
}

function formatProviderMessages(formated, flags, options = {}) {
  let messages = formated.map(cloneMessage);
  let systemPrompt = null;

  if (!flags.includes(LLM_FLAGS.hasFullSystemPrompt)) {
    if (flags.includes(LLM_FLAGS.hasFirstSystemPrompt)) {
      while (messages.length > 0 && messages[0].role === "system") {
        const current = messages.shift();
        if (systemPrompt) systemPrompt.content += `\n\n${current.content}`;
        else systemPrompt = current;
      }
    }

    for (const message of messages) {
      if (message.role !== "system") continue;
      message.content = options.systemContentReplacement
        ? options.systemContentReplacement.replace("{{slot}}", message.content)
        : `system: ${message.content}`;
      message.role = options.systemRoleReplacement || "user";
    }
  }

  if (flags.includes(LLM_FLAGS.requiresAlternateRole)) {
    const alternated = [];
    for (const message of messages) {
      const previous = alternated.at(-1);
      if (previous && previous.role === message.role)
        mergeMessage(previous, message);
      else alternated.push(message);
    }
    messages = alternated;
  }

  if (flags.includes(LLM_FLAGS.mustStartWithUserInput)) {
    if (messages.length === 0 || messages[0].role !== "user") {
      messages.unshift({ role: "user", content: " " });
    }
  }

  if (systemPrompt) messages.unshift(systemPrompt);
  return messages;
}

module.exports = { formatProviderMessages };
