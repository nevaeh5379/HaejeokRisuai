import { globalFetch } from "../../globalApi.svelte";
import { LLMFormat } from "../../model/modellist";
import { getDatabase } from "../../storage/database.svelte";
import { DEFAULT_COHERE_CHAT_URL } from "@risuai/chat-core/cohereProvider.cjs";
import type {
  RequestDataArgumentExtended,
  requestDataResponse,
} from "./requestContracts";
import { tryExecuteNodeProviderTransport } from "./nodeProviderExecutor";
import {
  applyAdditionalParameters,
  applyParameters,
  getAdditionalParameters,
} from "./shared";

export async function requestCohere(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  const formated = arg.formated;
  const db = getDatabase();
  const aiModel = arg.aiModel;

  let lastChatPrompt = "";
  let preamble = "";

  let lastChat = formated[formated.length - 1];
  if (lastChat.role === "user") {
    lastChatPrompt = lastChat.content;
    formated.pop();
  } else {
    while (lastChat.role !== "user") {
      lastChat = formated.pop();
      if (!lastChat) {
        return {
          type: "fail",
          result: "Cohere requires a user message to generate a response",
        };
      }
      lastChatPrompt =
        (lastChat.role === "user" ? "" : `${lastChat.role}: `) +
        "\n" +
        lastChat.content +
        lastChatPrompt;
    }
  }

  const firstChat = formated[0];
  if (firstChat.role === "system") {
    preamble = firstChat.content;
    formated.shift();
  }

  //reformat chat

  let body = applyParameters(
    {
      message: lastChatPrompt,
      chat_history: formated
        .map((v) => {
          if (v.role === "assistant") {
            return {
              role: "CHATBOT",
              message: v.content,
            };
          }
          if (v.role === "system") {
            return {
              role: "SYSTEM",
              message: v.content,
            };
          }
          if (v.role === "user") {
            return {
              role: "USER",
              message: v.content,
            };
          }
          return null;
        })
        .filter((v) => v !== null)
        .filter((v) => {
          return v.message;
        }),
    },
    ["temperature", "top_k", "top_p", "presence_penalty", "frequency_penalty"],
    {
      top_k: "k",
      top_p: "p",
    },
    arg.mode,
    {
      modelId: arg.aiModel,
    },
  );

  if (
    aiModel !== "cohere-command-r-03-2024" &&
    aiModel !== "cohere-command-r-plus-04-2024"
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

  let headers: Record<string, string> = {
    Authorization: "Bearer " + (arg.key ?? db.cohereAPIKey),
    "Content-Type": "application/json",
  };

  body = applyAdditionalParameters(
    body,
    headers,
    getAdditionalParameters(arg.aiModel),
  );
  console.log(body);

  if (arg.previewBody) {
    return {
      type: "success",
      result: JSON.stringify({
        url: arg.customURL ?? DEFAULT_COHERE_CHAT_URL,
        body: body,
        headers: headers,
      }),
    };
  }

  const remoteTransport =
    !arg.customURL && arg.modelInfo.format === LLMFormat.Cohere
      ? await tryExecuteNodeProviderTransport(
          LLMFormat.Cohere,
          { body, headers },
          arg.abortSignal,
        )
      : null;
  const res =
    remoteTransport ??
    (await globalFetch(arg.customURL ?? DEFAULT_COHERE_CHAT_URL, {
      method: "POST",
      headers: headers,
      body: body,
      abortSignal: arg.abortSignal,
    }));

  if (!res.ok) {
    return {
      type: "fail",
      result: JSON.stringify(res.data),
    };
  }

  const result = res?.data?.text;
  if (!result) {
    return {
      type: "fail",
      result: JSON.stringify(res.data),
    };
  }

  return {
    type: "success",
    result: result,
  };
}
