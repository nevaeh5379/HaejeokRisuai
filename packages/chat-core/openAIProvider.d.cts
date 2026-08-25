export const DEFAULT_OPENAI_CHAT_COMPLETIONS_URL: "https://api.openai.com/v1/chat/completions";

export interface OpenAIToolCallLike {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
  [key: string]: unknown;
}

export function collectOpenAIToolCalls(data: unknown): OpenAIToolCallLike[];

export function formatOpenAIReasoningText(
  data: unknown,
  options?: { deepSeekThinkingOutput?: boolean },
): string;
