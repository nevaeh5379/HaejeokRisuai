import type { MultiModal, OpenAIChat } from "./types.ts";

export type GoogleGenerationParameter =
  | "temperature"
  | "top_p"
  | "top_k"
  | "presence_penalty"
  | "frequency_penalty"
  | "thinking_tokens"
  | "reasoning_effort";

export interface GoogleResponseTextPart {
  text: string;
  thought?: boolean;
}

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

export type GoogleSafetyThreshold = "BLOCK_NONE" | "OFF";

export interface GoogleSafetySetting {
  category: string;
  threshold: GoogleSafetyThreshold;
}

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
("use strict");

const GOOGLE_GENERATIVE_LANGUAGE_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/models" =
  "https://generativelanguage.googleapis.com/v1beta/models";

const GOOGLE_GENERATION_PARAMETER_RENAMES: Readonly<
  Partial<Record<GoogleGenerationParameter, string>>
> = Object.freeze({
  top_p: "topP",
  top_k: "topK",
  presence_penalty: "presencePenalty",
  frequency_penalty: "frequencyPenalty",
  thinking_tokens: "thinkingBudget",
  reasoning_effort: "thinkingConfig.thinkingLevel",
});

function selectGoogleGenerationParameters(
  supportedParameters: readonly string[],
  options?: { thinking?: boolean },
): GoogleGenerationParameter[];
function selectGoogleGenerationParameters(
  supportedParameters?: any,
  options: any = {},
): any {
  const candidates: any = [
    "temperature",
    "top_p",
    "top_k",
    "presence_penalty",
    "frequency_penalty",
  ];
  if (options.thinking) {
    candidates.push("thinking_tokens", "reasoning_effort");
  }
  return candidates.filter((parameter?: any) =>
    supportedParameters.includes(parameter),
  );
}

function selectGoogleVertexRegion(
  modelId: string,
  configuredRegion: string,
): string;
function selectGoogleVertexRegion(modelId?: any, configuredRegion?: any): any {
  // Gemini 3 preview models and the 3.5/3.6/3.7 Flash family are not served
  // from the regions exposed by the browser settings.
  if (
    /^gemini-3-.*-preview$/.test(modelId) ||
    /^gemini-3\.[567]-flash/.test(modelId)
  ) {
    return "global";
  }
  return configuredRegion;
}

function formatGoogleTextResponse(
  textParts: readonly GoogleResponseTextPart[],
  options?: { transformText?: (text: string) => string },
): string;
function formatGoogleTextResponse(textParts?: any, options: any = {}): any {
  const thoughts: any = [];
  const content: any = [];
  for (const part of textParts) {
    const text: any = options.transformText
      ? options.transformText(part.text)
      : part.text;
    if (part.thought) {
      thoughts.push(text);
    } else {
      content.push(text);
    }
  }

  const thoughtText: any = thoughts.join("\n\n");
  const contentText: any = content.join("\n\n");
  return (
    (thoughtText ? `<Thoughts>\n\n${thoughtText}\n\n</Thoughts>\n\n` : "") +
    contentText
  );
}

function collectGoogleFunctionCalls(
  parts: readonly GeminiPart[],
): GeminiFunctionCall[];
function collectGoogleFunctionCalls(parts?: any): any {
  const calls: any = [];
  for (const part of parts) {
    if (part?.functionCall) calls.push(part.functionCall);
  }
  return calls;
}

function buildGoogleGenerateContentUrl(modelId: string, apiKey: string): string;
function buildGoogleGenerateContentUrl(modelId?: any, apiKey?: any): any {
  return `${GOOGLE_GENERATIVE_LANGUAGE_BASE_URL}/${modelId}:generateContent?key=${apiKey}`;
}

function prepareGoogleConversation(
  messages: readonly OpenAIChat[],
  options?: GoogleConversationOptions,
): GoogleConversationPreparation;
function prepareGoogleConversation(messages?: any, options: any = {}): any {
  const chats: any = [];
  let systemPrompt: any = "";
  let startIndex: any = 0;

  if (messages[0]?.role === "system") {
    systemPrompt = messages[0].content;
    startIndex = 1;
  }

  for (let index: any = startIndex; index < messages.length; index++) {
    const chat: any = messages[index];
    const previous: any = chats[chats.length - 1];

    if (chat.multimodals?.length) {
      const parts: any = [{ text: chat.content }];
      for (const modal of chat.multimodals) {
        const supported: any =
          (modal.type === "image" && options.hasImageInput) ||
          (modal.type === "audio" && options.hasAudioInput) ||
          (modal.type === "video" && options.hasVideoInput);
        if (supported) {
          const dataurl: any = modal.base64;
          const base64: any = dataurl.split(",")[1];
          const mediaType: any = dataurl.split(";")[0].split(":")[1];
          parts.push({ inlineData: { mimeType: mediaType, data: base64 } });
          continue;
        }
        if (modal.type === "signature" && options.resolveSignature) {
          const signaturePart: any = options.resolveSignature(modal);
          if (signaturePart) parts.push(signaturePart);
        }
      }
      chats.push({
        role: chat.role === "user" ? "user" : "model",
        parts,
      });
      continue;
    }

    if (chat.role === "system") {
      if (previous?.role === "user") {
        previous.parts[0].text += `
system:${chat.content}`;
      } else {
        chats.push({
          role: "user",
          parts: [{ text: `${chat.role}:${chat.content}` }],
        });
      }
      continue;
    }

    if (chat.role === "assistant" || chat.role === "user") {
      chats.push({
        role: chat.role === "user" ? "user" : "model",
        parts: [{ text: chat.content }],
      });
      continue;
    }

    chats.push({
      role: "user",
      parts: [{ text: `${chat.role}:${chat.content}` }],
    });
  }

  return {
    chats,
    systemPrompt,
    consumedLeadingSystem: startIndex === 1,
  };
}

function finalizeGoogleGenerationConfig(
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
function finalizeGoogleGenerationConfig(
  generationConfig?: any,
  options: any = {},
): any {
  if (options.thinking) {
    if (generationConfig.thinkingBudget !== undefined) {
      generationConfig.thinkingConfig = {
        thinkingBudget: generationConfig.thinkingBudget,
        includeThoughts: true,
      };
      delete generationConfig.thinkingBudget;
    } else if (generationConfig.thinkingConfig) {
      if (
        generationConfig.thinkingConfig.thinkingLevel === "minimal" &&
        options.thinkingNoMinimal
      ) {
        generationConfig.thinkingConfig.thinkingLevel = "low";
      }
      generationConfig.thinkingConfig.includeThoughts = true;
    }
  }

  let useStreaming: any = Boolean(options.useStreaming);
  if (options.hasAudioOutput) {
    generationConfig.responseModalities = ["TEXT", "AUDIO"];
    useStreaming = false;
  }
  if (options.imageResponse || options.hasImageOutput) {
    generationConfig.responseModalities = ["TEXT", "IMAGE"];
    useStreaming = false;
  }
  if (options.highMediaResolution) {
    generationConfig.mediaResolution = "MEDIA_RESOLUTION_MEDIUM";
  }

  return { generationConfig, useStreaming };
}

function buildGoogleSafetySettings(options?: {
  includeCivicIntegrity?: boolean;
  blockOff?: boolean;
}): GoogleSafetySetting[];
function buildGoogleSafetySettings(options: any = {}): any {
  const threshold: any = options.blockOff ? "OFF" : "BLOCK_NONE";
  const categories: any = [
    "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    "HARM_CATEGORY_HATE_SPEECH",
    "HARM_CATEGORY_HARASSMENT",
    "HARM_CATEGORY_DANGEROUS_CONTENT",
  ];
  if (options.includeCivicIntegrity !== false) {
    categories.push("HARM_CATEGORY_CIVIC_INTEGRITY");
  }
  return categories.map((category?: any) => ({ category, threshold }));
}

function mergeGoogleConsecutiveChats(chats: GeminiChat[]): GeminiChat[];
function mergeGoogleConsecutiveChats(chats?: any): any {
  for (let index: any = chats.length - 1; index >= 1; index--) {
    const current: any = chats[index];
    const previous: any = chats[index - 1];
    if (current.role !== previous.role) continue;

    const previousLastPart: any = previous.parts[previous.parts.length - 1];
    const currentFirstPart: any = current.parts[0];
    if (previousLastPart?.text && currentFirstPart?.text) {
      previousLastPart.text += `\n\n${currentFirstPart.text}`;
      previous.parts.push(...current.parts.slice(1));
    } else {
      previous.parts.push(...current.parts);
    }
    chats.splice(index, 1);
  }
  return chats;
}

export {
  GOOGLE_GENERATIVE_LANGUAGE_BASE_URL,
  GOOGLE_GENERATION_PARAMETER_RENAMES,
  buildGoogleGenerateContentUrl,
  selectGoogleGenerationParameters,
  selectGoogleVertexRegion,
  formatGoogleTextResponse,
  collectGoogleFunctionCalls,
  prepareGoogleConversation,
  mergeGoogleConsecutiveChats,
  buildGoogleSafetySettings,
  finalizeGoogleGenerationConfig,
};
