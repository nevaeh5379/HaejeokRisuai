import type { ChatModelResponse } from "./types.cjs";

export interface ChatRequestFallbackOptions {
  fallbackModels: readonly string[];
  requestRetries: number;
  antiServerOverloads: boolean;
  fallbackWhenBlankResponse: boolean;
  bannedCharacterSets?: readonly string[];
}

export interface ChatRequestAttemptContext {
  fallbackIndex: number;
  fallbackCount: number;
  fallbackModel: string;
  retryCount: number;
}

export interface ChatRequestFallbackRuntime {
  beginFallback?(context: Omit<ChatRequestAttemptContext, "retryCount">): void | Promise<void>;
  executeAttempt(context: ChatRequestAttemptContext): Promise<ChatModelResponse>;
  isAborted?(): boolean;
  sleep?(delayMs: number): Promise<void>;
}

export function executeChatRequestFallbacks(
  options: ChatRequestFallbackOptions,
  runtime: ChatRequestFallbackRuntime,
): Promise<ChatModelResponse>;
