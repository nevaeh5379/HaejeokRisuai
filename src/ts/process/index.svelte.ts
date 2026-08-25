import { writable } from "svelte/store";
import { chatProcessStage, doingChat } from "./chatRuntimeState";
export { chatProcessStage, doingChat } from "./chatRuntimeState";
import { createLocalChatExecutor } from "./chatLocalExecutor";
import type { ChatSendOptions } from "@risuai/chat-core/executor.cjs";

export type { MultiModal, OpenAIChat } from "@risuai/chat-core/types.cjs";
import type { OpenAIChat } from "@risuai/chat-core/types.cjs";

export interface requestTokenPart {
  name: string;
  tokens: number;
}

export const abortChat = writable(false);
export let requestTokenParts: { [key: string]: requestTokenPart[] } = {};
export let previewFormated: OpenAIChat[] = [];
export let previewBody: string = "";

const localChatExecutor = createLocalChatExecutor({
  setPreviewFormated: (chats) => {
    previewFormated = chats;
  },
  setPreviewBody: (body) => {
    previewBody = body;
  },
});

export async function sendChat(
  chatProcessIndex = -1,
  arg: ChatSendOptions = {},
): Promise<boolean> {
  return localChatExecutor.execute(chatProcessIndex, arg);
}
