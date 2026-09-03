import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { language } from "src/lang";
import {
  DEFAULT_MISTRAL_API_URL,
  decodeMistralResponse,
  formatMistralMessages,
} from "@risuai/chat-core/mistralProvider.cjs";
import { globalFetch } from "src/ts/globalApi.svelte";

import { LLMFormat } from "src/ts/model/modellist";
import type {
  RequestDataArgumentExtended,
  requestDataResponse,
} from "../requestContracts";
import { tryExecuteNodeProvider } from "../nodeProviderExecutor";
import { applyParameters } from "../shared";
import type { OpenAIChatExtra } from "./types";
import { getLocalNetworkRequestOptions } from "./shared";

export function resolveMistralRequestUrl(customURL?: string): string {
  return customURL ?? DEFAULT_MISTRAL_API_URL;
}

export function shouldUseNodeMistralTransport(requestURL: string): boolean {
  return requestURL === DEFAULT_MISTRAL_API_URL;
}
export async function requestMistral(
  arg: RequestDataArgumentExtended,
  formatedChat: OpenAIChatExtra[],
): Promise<requestDataResponse> {
  const db = settingsStore.state;
  const reformatedChat = formatMistralMessages(formatedChat);
  const requestURL = resolveMistralRequestUrl(arg.customURL);
  const networkOptions = getLocalNetworkRequestOptions(requestURL);

  const body = applyParameters(
    {
      model: arg.modelInfo.internalID || arg.aiModel,
      messages: reformatedChat,
      safe_prompt: false,
      max_tokens: arg.maxTokens,
    },
    ["temperature", "presence_penalty", "frequency_penalty", "top_p"],
    {},
    arg.mode,
    { modelId: arg.modelInfo.id },
  );
  const headers = {
    Authorization: "Bearer " + (arg.key ?? db.mistralKey),
  };
  if (arg.previewBody) {
    return {
      type: "success",
      result: JSON.stringify({ url: requestURL, body, headers }),
    };
  }

  if (shouldUseNodeMistralTransport(requestURL)) {
    const remote = await tryExecuteNodeProvider(
      LLMFormat.Mistral,
      {
        body,
        apiKey: arg.key ?? db.mistralKey,
        httpErrorPrefix: language.errors.httpError,
      },
      arg.abortSignal,
    );
    if (remote) return remote;
  }

  const response = await globalFetch(requestURL, {
    body,
    headers,
    abortSignal: arg.abortSignal,
    chatId: arg.chatId,
    interceptor: "mistral",
    networkRoute: networkOptions.networkRoute,
    requestTimeoutMs: networkOptions.requestTimeoutMs,
  });
  return decodeMistralResponse(
    response.ok,
    response.data,
    language.errors.httpError,
  );
}
