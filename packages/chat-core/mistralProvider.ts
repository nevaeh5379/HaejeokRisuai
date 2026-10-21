import type { ChatFailureResponse, ChatSuccessResponse } from "./types.ts";

export interface MistralMessage {
  role: string;
  content: unknown;
}

const DEFAULT_MISTRAL_API_URL: string =
  "https://api.mistral.ai/v1/chat/completions";

function formatMistralMessages<T extends MistralMessage>(
  messages: readonly T[],
): Array<{ role: string; content: unknown }> {
  const result: Array<{ role: string; content: unknown }> = [];
  for (const chat of messages) {
    if (result.length === 0) {
      if (chat.role === "user" || chat.role === "system") {
        result.push({ role: chat.role, content: chat.content });
      } else {
        result.push({
          role: "system",
          content: `${chat.role}:${chat.content}`,
        });
      }
      continue;
    }

    const previous = result[result.length - 1];
    if (previous?.role === chat.role) {
      previous.content = `${previous.content}\n${chat.content}`;
      continue;
    }

    if (chat.role === "system") {
      if (previous?.role === "user") {
        previous.content = `${previous.content}\nSystem:${chat.content}`;
      } else {
        result.push({ role: "user", content: `System:${chat.content}` });
      }
      continue;
    }
    if (chat.role === "function") {
      result.push({ role: "user", content: chat.content });
      continue;
    }

    result.push({ role: chat.role, content: chat.content });
  }
  return result;
}

function decodeMistralResponse(
  ok: boolean,
  data: any,
  httpErrorPrefix = "",
): ChatSuccessResponse | ChatFailureResponse {
  if (ok) {
    try {
      return {
        type: "success",
        result: data.choices[0].message.content ?? "",
      };
    } catch {
      return {
        type: "fail",
        result: `${httpErrorPrefix}${JSON.stringify(data)}`,
      };
    }
  }

  const errorMessage: string | undefined = data?.error?.message;
  return {
    type: "fail",
    result: `${httpErrorPrefix}${errorMessage ?? JSON.stringify(data)}`,
  };
}

export {
  DEFAULT_MISTRAL_API_URL,
  decodeMistralResponse,
  formatMistralMessages,
};
