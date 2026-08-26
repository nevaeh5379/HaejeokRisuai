import type { MultiModal, OpenAIChat } from "./types.cjs";

export const GOOGLE_GENERATIVE_LANGUAGE_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/models";

export interface GeminiFunctionCall {
  id?: string;
  name: string;
  args: any;
}

export interface GeminiFunctionResponse {
  id?: string;
  name: string;
  response: any;
}

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
  functionCall?: GeminiFunctionCall;
  functionResponse?: GeminiFunctionResponse;
}

export interface GeminiChat {
  role: "user" | "model" | "function";
  parts: GeminiPart[];
}

export interface GoogleConversationOptions {
  hasImageInput?: boolean;
  hasAudioInput?: boolean;
  hasVideoInput?: boolean;
  resolveSignature?: (modal: MultiModal) => GeminiPart | null | undefined;
}

export interface GoogleConversationPreparation {
  chats: GeminiChat[];
  systemPrompt: string;
  consumedLeadingSystem: boolean;
}

export function buildGoogleGenerateContentUrl(
  modelId: string,
  apiKey: string,
): string;

export function prepareGoogleConversation(
  messages: readonly OpenAIChat[],
  options?: GoogleConversationOptions,
): GoogleConversationPreparation;

export function mergeGoogleConsecutiveChats(
  chats: GeminiChat[],
): GeminiChat[];
