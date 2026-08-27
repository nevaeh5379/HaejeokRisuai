import type { character, groupChat, Chat, MessageGenerationInfo, MessagePresetInfo } from "../storage/schema";
import type { ChatModelResponse } from "@risuai/chat-core/types.cjs";
import { processStreamingResponse } from "./chatStreamingResponse.svelte";
import { processNonStreamingResponse } from "./chatNonStreamingResponse.svelte";

export interface ProcessChatResponseOptions {
  req: ChatModelResponse;
  abortSignal: AbortSignal;
  selectedChar: number;
  selectedChat: number;
  currentChar: character;
  nowChatroom: character | groupChat;
  currentChat: Chat;
  continueGeneration?: boolean;
  generationInfo: MessageGenerationInfo;
  promptInfo: MessagePresetInfo;
  generationId: string;
  reformatContent: (data: string) => string;
  throwError: (error: string) => void;
}

export async function processChatResponse(options: ProcessChatResponseOptions) {
  if (options.req.type === "fail") {
    options.throwError(options.req.result);
    return {
      ok: false as const,
      result: "",
      emoChanged: false,
      resendChat: false,
      currentChat: options.currentChat,
    };
  }
  if (options.req.type === "streaming") {
    return processStreamingResponse({ ...options, req: options.req });
  }
  return processNonStreamingResponse({ ...options, req: options.req });
}
