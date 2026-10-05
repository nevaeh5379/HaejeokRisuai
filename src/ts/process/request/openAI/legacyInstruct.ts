import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { DEFAULT_OPENAI_COMPLETIONS_URL } from "@risuai/chat-core/openAIProvider.cjs";
import { language } from "src/lang";
import { globalFetch } from "src/ts/globalApi.svelte";
import { LLMFormat } from "src/ts/model/modellist";

import type {
  RequestDataArgumentExtended,
  requestDataResponse,
} from "../requestContracts";
import { tryExecuteNodeProviderTransport } from "../nodeProviderExecutor";
import { applyAdditionalParameters, getAdditionalParameters } from "../shared";

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

/**
 * Prepares or executes a legacy OpenAI completions request from the formatted chat prompt.
 *
 * 한국어: 형식화한 채팅 프롬프트로 기존 OpenAI completions 요청을 준비하거나 실행하는 함수.
 *
 * @param arg - Provider arguments, including custom URL and preview selection. / 사용자 URL·미리보기 선택을 포함한 제공자 인자.
 * @remarks
 * Preview returns final URL/headers/body without executing so Node illustration jobs can run independently.
 * 한국어: 미리보기는 실행 없이 최종 URL·헤더·본문을 반환해 Node 삽화 작업의 독립 실행을 지원.
 */
export async function requestOpenAILegacyInstruct(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  const db = settingsStore.state;
  const prompt = buildOpenAILegacyInstructPrompt(arg.formated);

  let body: any = {
    model: "gpt-3.5-turbo-instruct",
    prompt,
    max_tokens: arg.maxTokens,
    temperature: arg.temperature,
    top_p: 1,
    stop: ["User:", " User:", "user:", " user:"],
    presence_penalty:
      arg.PresensePenalty || presetStore.state.PresensePenalty / 100,
    frequency_penalty:
      arg.frequencyPenalty || presetStore.state.frequencyPenalty / 100,
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

  const requestURL = arg.customURL ?? DEFAULT_OPENAI_COMPLETIONS_URL;
  if (arg.previewBody)
    return {
      type: "success",
      result: JSON.stringify({ url: requestURL, body, headers }),
    };

  const remoteTransport =
    requestURL === DEFAULT_OPENAI_COMPLETIONS_URL &&
    arg.modelInfo.format === LLMFormat.OpenAILegacyInstruct
      ? await tryExecuteNodeProviderTransport(
          LLMFormat.OpenAILegacyInstruct,
          { body, headers },
          arg.abortSignal,
        )
      : null;
  const response =
    remoteTransport ??
    (await globalFetch(requestURL, {
      body,
      headers,
      chatId: arg.chatId,
      abortSignal: arg.abortSignal,
    }));

  if (!response.ok) {
    return {
      type: "fail",
      result: language.errors.httpError + `${JSON.stringify(response.data)}`,
    };
  }
  const text: string = response.data.choices[0].text;
  return { type: "success", result: text.replace(/##\n/g, "") };
}
