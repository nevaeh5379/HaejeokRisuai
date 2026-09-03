import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { globalFetch } from "../../globalApi.svelte";
import { LLMFormat } from "../../model/modellist";

import {
  DEFAULT_COHERE_CHAT_URL,
  decodeCohereResponse,
  prepareCohereConversation,
} from "@risuai/chat-core/cohereProvider.cjs";
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
  const db = settingsStore.state;
  const aiModel = arg.aiModel;

  const conversation = prepareCohereConversation(
    formated,
    arg.modelInfo.internalID || aiModel,
  );
  if (conversation.ok === false) {
    return {
      type: "fail",
      result: conversation.error,
    };
  }

  let body = applyParameters(
    conversation.body,
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

  return decodeCohereResponse(res.ok, res.data);
}
