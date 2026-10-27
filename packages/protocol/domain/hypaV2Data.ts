import type { OpenAIChat } from "../../chat-core/types.ts";

export interface HypaV2Data {
  lastMainChunkID: number; // can be removed, but exists to more readability of the code.
  mainChunks: {
    // summary itself
    id: number;
    text: string;
    chatMemos: Set<string>; // UUIDs of summarized chats
    lastChatMemo: string;
  }[];
  chunks: {
    // split mainChunks for retrieval or something. Although quite uncomfortable logic, so maybe I will delete it soon.
    mainChunkID: number;
    text: string;
  }[];
}

// Reuse HypaV2Data and override only chatMemos in mainChunks
export interface SerializableHypaV2Data extends Omit<HypaV2Data, "mainChunks"> {
  mainChunks: {
    id: number;
    text: string;
    chatMemos: string[]; // Override Set<string> with string[]
    lastChatMemo: string;
  }[];
}

export interface OldHypaV2Data {
  chunks: {
    text: string;
    targetId: string;
  }[];
  mainChunks: {
    text: string;
    targetId: string;
  }[];
}

