import type { OpenAIChat } from "./types.cjs";

export const DEFAULT_ANTHROPIC_MESSAGES_URL: "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_NO_INPUT_ERROR: "No input";

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

export function prepareAnthropicConversation(
  messages: readonly OpenAIChat[],
  options?: { oneHourCaching?: boolean },
): AnthropicConversationPreparation;
