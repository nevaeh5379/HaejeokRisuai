import type { ChatModelResponse, OpenAIChat } from "./types.cjs";

export const DEFAULT_COHERE_CHAT_URL: "https://api.cohere.com/v1/chat";
export const COHERE_USER_MESSAGE_ERROR: "Cohere requires a user message to generate a response";

export interface CohereChatHistoryItem {
  role: "CHATBOT" | "SYSTEM" | "USER";
  message: string;
}

export interface CohereConversationBody {
  message: string;
  chat_history: CohereChatHistoryItem[];
  safety_mode?: "NONE";
  preamble?: string;
}

export type CohereConversationPreparation =
  | { ok: true; body: CohereConversationBody }
  | { ok: false; error: string };

export function prepareCohereConversation(
  messages: readonly OpenAIChat[],
  modelId: string,
): CohereConversationPreparation;

export function decodeCohereResponse(
  ok: boolean,
  data: unknown,
): ChatModelResponse;
