import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { globalFetch } from "../../globalApi.svelte";
import { LLMFormat } from "../../model/modellist";

import {
  DEFAULT_NOVELLIST_API_URL,
  buildNovelListRequestBody,
} from "@risuai/chat-core/novelListProvider.cjs";
import { stringlizeAINChat, unstringlizeAIN } from "../stringlize";
import { resolveRequestCharacter } from "./requestContext";
import type {
  RequestDataArgumentExtended,
  requestDataResponse,
} from "./requestContracts";
import { tryExecuteNodeProviderTransport } from "./nodeProviderExecutor";
import { applyAdditionalParameters, getAdditionalParameters } from "./shared";

export async function requestNovelList(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  const formated = arg.formated;
  const db = settingsStore.state;
  const maxTokens = arg.maxTokens;
  const temperature = arg.temperature;
  const biasString = arg.biasString;
  const currentChar = resolveRequestCharacter(arg);
  const aiModel = arg.aiModel;
  const auth_key = db.novellistAPI;
  let headers: Record<string, string> = {
    Authorization: `Bearer ${auth_key}`,
    "Content-Type": "application/json",
  };

  let send_body: Record<string, any> = buildNovelListRequestBody({
    text: stringlizeAINChat(
      formated,
      currentChar?.name ?? "",
      arg.continue,
      arg.triggerTarget,
    ),
    maxTokens,
    temperature,
    sampler: presetStore.state.ainconfig,
    modelId: aiModel,
    biasString,
  });

  send_body = applyAdditionalParameters(
    send_body,
    headers,
    getAdditionalParameters(arg.aiModel),
  );

  if (arg.previewBody) {
    return {
      type: "success",
      result: JSON.stringify({
        url: arg.customURL ?? DEFAULT_NOVELLIST_API_URL,
        body: send_body,
        headers: headers,
      }),
    };
  }
  const remoteTransport =
    !arg.customURL && arg.modelInfo.format === LLMFormat.NovelList
      ? await tryExecuteNodeProviderTransport(
          LLMFormat.NovelList,
          { body: send_body, headers },
          arg.abortSignal,
        )
      : null;
  const response =
    remoteTransport ??
    (await globalFetch(arg.customURL ?? DEFAULT_NOVELLIST_API_URL, {
      method: "POST",
      headers: headers,
      body: send_body,
      chatId: arg.chatId,
      abortSignal: arg.abortSignal,
    }));

  if (!response.ok) {
    return {
      type: "fail",
      result: response.data,
    };
  }

  if (response.data.error) {
    return {
      type: "fail",
      result: `${response.data.error.replace("token", "api key")}`,
    };
  }

  const result = response.data.data[0];
  const unstr = unstringlizeAIN(
    result,
    formated,
    currentChar?.name ?? "",
    arg.triggerTarget,
  );
  return {
    type: "multiline",
    result: unstr,
  };
}
