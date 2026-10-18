import type { OpenAIChat } from "./types.ts";

export interface Claude3CacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
}

export interface Claude3TextBlock {
  type: "text";
  text: string;
  cache_control?: Claude3CacheControl;
}

export interface Claude3ImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
  cache_control?: Claude3CacheControl;
}

export interface Claude3ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: any;
  cache_control?: Claude3CacheControl;
}

export interface Claude3ToolResponseBlock {
  type: "tool_result";
  tool_use_id: string;
  content: Claude3ContentBlock[];
  cache_control?: Claude3CacheControl;
}

export type Claude3ContentBlock =
  | Claude3TextBlock
  | Claude3ImageBlock
  | Claude3ToolUseBlock
  | Claude3ToolResponseBlock;

export interface Claude3Chat {
  role: "user" | "assistant";
  content: Claude3ContentBlock[];
}

export interface Claude3ExtendedChat {
  role: "user" | "assistant";
  content: Claude3ContentBlock[] | string;
}

export type AnthropicConversationPreparation =
  | { ok: true; messages: Claude3Chat[]; systemPrompt: string }
  | { ok: false; error: string };
("use strict");

const DEFAULT_ANTHROPIC_MESSAGES_URL: "https://api.anthropic.com/v1/messages" =
  "https://api.anthropic.com/v1/messages";
const ANTHROPIC_NO_INPUT_ERROR: "No input" = "No input";

function createCacheControl(oneHourCaching?: any): any {
  return oneHourCaching
    ? { type: "ephemeral", ttl: "1h" }
    : { type: "ephemeral" };
}

function prepareAnthropicConversation(
  messages: readonly OpenAIChat[],
  options?: { oneHourCaching?: boolean },
): AnthropicConversationPreparation;
function prepareAnthropicConversation(messages?: any, options: any = {}): any {
  const claudeChat: any = [];
  let systemPrompt: any = "";
  const oneHourCaching: any = Boolean(options.oneHourCaching);

  function addClaudeChat(chat?: any, multimodals?: any): any {
    if (
      claudeChat.length > 0 &&
      claudeChat[claudeChat.length - 1].role === chat.role
    ) {
      const content: any = claudeChat[claudeChat.length - 1].content;
      const lastContent: any = content[content.length - 1];
      if (lastContent?.type === "text") {
        lastContent.text += `

${chat.content}`;
      } else {
        content.push({ type: "text", text: chat.content });
      }

      if (multimodals?.length) {
        for (const modal of multimodals) {
          if (modal.type !== "image") continue;
          const dataurl: any = modal.base64;
          const base64: any = dataurl.split(",")[1];
          const mediaType: any = dataurl.split(";")[0].split(":")[1];
          content.unshift({
            type: "image",
            source: { type: "base64", media_type: mediaType, data: base64 },
          });
        }
      }

      if (chat.cache) {
        content[content.length - 1].cache_control =
          createCacheControl(oneHourCaching);
      }
      return;
    }

    const content: any = [{ type: "text", text: chat.content }];
    if (multimodals?.length) {
      for (const modal of multimodals) {
        if (modal.type !== "image") continue;
        const dataurl: any = modal.base64;
        const base64: any = dataurl.split(",")[1];
        const mediaType: any = dataurl.split(";")[0].split(":")[1];
        content.unshift({
          type: "image",
          source: { type: "base64", media_type: mediaType, data: base64 },
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
      case "user":
      case "assistant":
        addClaudeChat(
          { role: chat.role, content: chat.content, cache: chat.cachePoint },
          chat.multimodals,
        );
        break;
      case "system":
        if (claudeChat.length === 0) {
          systemPrompt += `

${chat.content}`;
        } else {
          addClaudeChat({
            role: "user",
            content: `System: ${chat.content}`,
            cache: chat.cachePoint,
          });
        }
        break;
      case "function":
        break;
    }
  }

  if (claudeChat.length === 0 && systemPrompt === "") {
    return { ok: false, error: ANTHROPIC_NO_INPUT_ERROR };
  }
  if (claudeChat.length === 0 && systemPrompt !== "") {
    claudeChat.push({
      role: "user",
      content: [{ type: "text", text: "Start" }],
    });
    systemPrompt = "";
  }
  if (claudeChat[0].role !== "user") {
    claudeChat.unshift({
      role: "user",
      content: [{ type: "text", text: "Start" }],
    });
  }

  return { ok: true, messages: claudeChat, systemPrompt };
}

export {
  DEFAULT_ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_NO_INPUT_ERROR,
  prepareAnthropicConversation,
};
