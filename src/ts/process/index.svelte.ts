import { writable } from "svelte/store";
import { chatProcessStage, doingChat } from "./chatRuntimeState";
export { chatProcessStage, doingChat } from "./chatRuntimeState";
import { createLocalChatExecutor } from "./chatLocalExecutor";
import type { ChatSendOptions } from "./chat-core/executor";

export type { MultiModal, OpenAIChat } from "./chat-core/types";
import type { OpenAIChat } from "./chat-core/types";

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
