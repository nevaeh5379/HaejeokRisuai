import type { loreBook } from "./lorebook.ts";
import type { SerializableHypaV2Data } from "../hypaV2Data.ts";
import type { SerializableHypaV3Data } from "../hypaV3Data.ts";
import type { OpenAIChat } from "../../../chat-core/types.ts";

export type StreamingDisplayOptimizationMode = "off" | "balanced" | "strong";

/** Upstream compatibility types, copied from kwaroran/Risuai commit
 * 39f1ac1472d0ef6907ee933c4cf25182ee2aec9f, src/ts/storage/database.svelte.ts.
 * Keep fork-only fields in ChatFields/ChatState, never in this contract. */
export interface Chat {
  message: Message[];
  note: string;
  name: string;
  localLore: loreBook[];
  sdData?: string;
  supaMemoryData?: string;
  hypaV2Data?: SerializableHypaV2Data;
  lastMemory?: string;
  suggestMessages?: string[];
  isStreaming?: boolean;
  activeStreamingDisplayOptimizationMode?: StreamingDisplayOptimizationMode;
  scriptstate?: { [key: string]: string | number | boolean };
  modules?: string[];
  id?: string;
  bindedPersona?: string;
  fmIndex?: number;
  hypaV3Data?: SerializableHypaV3Data;
  folderId?: string;
  lastDate?: number;
  bookmarks?: string[];
  bookmarkNames?: { [chatId: string]: string };
  useLocallySetGlobalVariables?: boolean;
  GLGlobalVariables?: { [key: string]: string };
  onboardingDone?: boolean;
}

export interface Message {
  role: "user" | "char";
  data: string;
  saying?: string;
  chatId?: string;
  time?: number;
  generationInfo?: MessageGenerationInfo;
  promptInfo?: MessagePresetInfo;
  name?: string;
  otherUser?: boolean;
  disabled?: false | true | "allBefore";
  isComment?: boolean;
}

export interface MessageGenerationInfo {
  model?: string;
  generationId?: string;
  inputTokens?: number;
  outputTokens?: number;
  maxContext?: number;
  stageTiming?: {
    stage1?: number;
    stage2?: number;
    stage3?: number;
    stage4?: number;
  };
}

export interface MessagePresetInfo {
  promptName?: string;
  promptToggles?: { key: string; value: string }[];
  promptText?: OpenAIChat[];
}
