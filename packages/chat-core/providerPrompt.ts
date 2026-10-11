import type { OpenAIChat } from "./types.ts";

import type { LLMFlagValue } from "../protocol/modelFlags.ts";

export interface ProviderPromptFormatOptions {
  systemContentReplacement?: string;
  systemRoleReplacement?: string;
}
("use strict");

import { LLM_FLAGS } from "../protocol/modelFlags.ts";

function cloneMessage(message?: any): any {
  return {
    ...message,
    multimodals: message.multimodals ? [...message.multimodals] : undefined,
    thoughts: message.thoughts ? [...message.thoughts] : undefined,
  };
}

function mergeMessage(target?: any, source?: any): any {
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

function formatProviderMessages(
  formated: OpenAIChat[],
  flags: readonly LLMFlagValue[],
  options?: ProviderPromptFormatOptions,
): OpenAIChat[];
function formatProviderMessages(
  formated?: any,
  flags?: any,
  options: any = {},
): any {
  let messages: any = formated.map(cloneMessage);
  let systemPrompt: any = null;

  if (!flags.includes(LLM_FLAGS.hasFullSystemPrompt)) {
    if (flags.includes(LLM_FLAGS.hasFirstSystemPrompt)) {
      while (messages.length > 0 && messages[0].role === "system") {
        const current: any = messages.shift();
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
    const alternated: any = [];
    for (const message of messages) {
      const previous: any = alternated.at(-1);
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

export { formatProviderMessages };
