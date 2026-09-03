import type { MultiModal, OpenAIChat } from "./types.cjs";

export const GOOGLE_GENERATIVE_LANGUAGE_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/models";

export type GoogleGenerationParameter =
  | "temperature"
  | "top_p"
  | "top_k"
  | "presence_penalty"
  | "frequency_penalty"
  | "thinking_tokens"
  | "reasoning_effort";

export const GOOGLE_GENERATION_PARAMETER_RENAMES: Readonly<
  Partial<Record<GoogleGenerationParameter, string>>
>;

export function selectGoogleGenerationParameters(
  supportedParameters: readonly string[],
  options?: { thinking?: boolean },
): GoogleGenerationParameter[];

export function selectGoogleVertexRegion(
  modelId: string,
  configuredRegion: string,
): string;

export interface GoogleResponseTextPart {
  text: string;
  thought?: boolean;
}

export function formatGoogleTextResponse(
  textParts: readonly GoogleResponseTextPart[],
  options?: { transformText?: (text: string) => string },
): string;

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

export function collectGoogleFunctionCalls(
  parts: readonly GeminiPart[],
): GeminiFunctionCall[];

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

export function mergeGoogleConsecutiveChats(chats: GeminiChat[]): GeminiChat[];

export type GoogleSafetyThreshold = "BLOCK_NONE" | "OFF";
export interface GoogleSafetySetting {
  category: string;
  threshold: GoogleSafetyThreshold;
}
export function buildGoogleSafetySettings(options?: {
  includeCivicIntegrity?: boolean;
  blockOff?: boolean;
}): GoogleSafetySetting[];

export interface GoogleGenerationConfig extends Record<string, any> {
  thinkingBudget?: number;
  thinkingConfig?: {
    thinkingBudget?: number;
    thinkingLevel?: string;
    includeThoughts?: boolean;
  };
  responseModalities?: string[];
  mediaResolution?: string;
}
export function finalizeGoogleGenerationConfig(
  generationConfig: GoogleGenerationConfig,
  options?: {
    thinking?: boolean;
    thinkingNoMinimal?: boolean;
    useStreaming?: boolean;
    hasAudioOutput?: boolean;
    hasImageOutput?: boolean;
    imageResponse?: boolean;
    highMediaResolution?: boolean;
  },
): { generationConfig: GoogleGenerationConfig; useStreaming: boolean };
