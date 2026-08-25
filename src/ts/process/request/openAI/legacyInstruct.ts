import { language } from "src/lang";
import { globalFetch } from "src/ts/globalApi.svelte";
import { getDatabase } from "src/ts/storage/database.svelte";
import type {
  RequestDataArgumentExtended,
  requestDataResponse,
} from "../request";
import {
  applyAdditionalParameters,
  getAdditionalParameters,
} from "../shared";

export function buildOpenAILegacyInstructPrompt(
  formated: RequestDataArgumentExtended["formated"],
): string {
  return (
    formated
      .filter((message) => message.content?.trim())
      .map((message) => {
        let author = "";
        if (message.role === "system") {
          message.content = message.content.trim();
        }
        console.log(message.role + ":" + message.content);
        switch (message.role) {
          case "user":
            author = "User";
            break;
          case "assistant":
            author = "Assistant";
            break;
          case "system":
            author = "Instruction";
            break;
          default:
            author = message.role;
            break;
        }

        return `\n## ${author}\n${message.content.trim()}`;
      })
      .join("") + `\n## Response\n`
  );
}

export async function requestOpenAILegacyInstruct(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  const db = getDatabase();
  const prompt = buildOpenAILegacyInstructPrompt(arg.formated);
  if (arg.previewBody) {
    return {
      type: "success",
      result: JSON.stringify({
        error: "This model is not supported in preview mode",
      }),
    };
  }

  let body: any = {
    model: "gpt-3.5-turbo-instruct",
    prompt,
    max_tokens: arg.maxTokens,
    temperature: arg.temperature,
    top_p: 1,
    stop: ["User:", " User:", "user:", " user:"],
    presence_penalty: arg.PresensePenalty || db.PresensePenalty / 100,
    frequency_penalty: arg.frequencyPenalty || db.frequencyPenalty / 100,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + (arg.key ?? db.openAIKey),
  };
  body = applyAdditionalParameters(
    body,
    headers,
    getAdditionalParameters(arg.aiModel),
  );

  const response = await globalFetch(
    arg.customURL ?? "https://api.openai.com/v1/completions",
    {
      body,
      headers,
      chatId: arg.chatId,
      abortSignal: arg.abortSignal,
    },
  );

  if (!response.ok) {
    return {
      type: "fail",
      result: language.errors.httpError + `${JSON.stringify(response.data)}`,
    };
  }
  const text: string = response.data.choices[0].text;
  return { type: "success", result: text.replace(/##\n/g, "") };
}
