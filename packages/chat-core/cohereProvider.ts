import type { ChatModelResponse, OpenAIChat } from "./types.ts";

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
  { ok: true; body: CohereConversationBody } | { ok: false; error: string };
("use strict");

const DEFAULT_COHERE_CHAT_URL: "https://api.cohere.com/v1/chat" =
  "https://api.cohere.com/v1/chat";
const COHERE_USER_MESSAGE_ERROR: "Cohere requires a user message to generate a response" =
  "Cohere requires a user message to generate a response";

function prepareCohereConversation(
  messages: readonly OpenAIChat[],
  modelId: string,
): CohereConversationPreparation;
function prepareCohereConversation(messages?: any, modelId?: any): any {
  const formated: any = messages.map((message?: any) => ({
    role: message.role,
    content: message.content,
  }));
  let lastChatPrompt: any = "";
  let preamble: any = "";
  let lastChat: any = formated[formated.length - 1];

  if (lastChat?.role === "user") {
    lastChatPrompt = lastChat.content;
    formated.pop();
  } else {
    while (lastChat?.role !== "user") {
      lastChat = formated.pop();
      if (!lastChat) {
        return { ok: false, error: COHERE_USER_MESSAGE_ERROR };
      }
      lastChatPrompt =
        (lastChat.role === "user" ? "" : `${lastChat.role}: `) +
        "\n" +
        lastChat.content +
        lastChatPrompt;
    }
  }

  const firstChat: any = formated[0];
  if (firstChat?.role === "system") {
    preamble = firstChat.content;
    formated.shift();
  }

  const body: any = {
    message: lastChatPrompt,
    chat_history: formated
      .map((message?: any) => {
        if (message.role === "assistant") {
          return { role: "CHATBOT", message: message.content };
        }
        if (message.role === "system") {
          return { role: "SYSTEM", message: message.content };
        }
        if (message.role === "user") {
          return { role: "USER", message: message.content };
        }
        return null;
      })
      .filter((message?: any) => message?.message),
  };

  if (
    modelId !== "cohere-command-r-03-2024" &&
    modelId !== "cohere-command-r-plus-04-2024"
  ) {
    body.safety_mode = "NONE";
  }

  if (preamble) {
    if (body.chat_history.length > 0) {
      body.preamble = preamble;
    } else {
      body.message = `system: ${preamble}`;
    }
  }

  return { ok: true, body };
}

function decodeCohereResponse(ok: boolean, data: unknown): ChatModelResponse;
function decodeCohereResponse(ok?: any, data?: any): any {
  if (!ok) {
    return { type: "fail", result: JSON.stringify(data) };
  }

  const result: any = data?.text;
  if (!result) {
    return { type: "fail", result: JSON.stringify(data) };
  }

  return { type: "success", result };
}

export {
  DEFAULT_COHERE_CHAT_URL,
  COHERE_USER_MESSAGE_ERROR,
  prepareCohereConversation,
  decodeCohereResponse,
};
