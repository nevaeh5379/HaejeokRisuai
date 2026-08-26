import { globalFetch } from "../../globalApi.svelte";
import { LLMFormat } from "../../model/modellist";
import { getCurrentCharacter, getDatabase } from "../../storage/database.svelte";
import { DEFAULT_NOVELLIST_API_URL } from "@risuai/chat-core/novelListProvider.cjs";
import { stringlizeAINChat, unstringlizeAIN } from "../stringlize";
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
  const db = getDatabase();
  const maxTokens = arg.maxTokens;
  const temperature = arg.temperature;
  const biasString = arg.biasString;
  const currentChar = getCurrentCharacter();
  const aiModel = arg.aiModel;
  const auth_key = db.novellistAPI;
  const logit_bias: string[] = [];
  const logit_bias_values: string[] = [];
  for (let i = 0; i < biasString.length; i++) {
    const bia = biasString[i];
    logit_bias.push(bia[0]);
    logit_bias_values.push(bia[1].toString());
  }

  let headers: Record<string, string> = {
    Authorization: `Bearer ${auth_key}`,
    "Content-Type": "application/json",
  };

  let send_body: Record<string, any> = {
    text: stringlizeAINChat(formated, currentChar?.name ?? "", arg.continue),
    length: maxTokens,
    temperature: temperature,
    top_p: db.ainconfig.top_p,
    top_k: db.ainconfig.top_k,
    rep_pen: db.ainconfig.rep_pen,
    top_a: db.ainconfig.top_a,
    rep_pen_slope: db.ainconfig.rep_pen_slope,
    rep_pen_range: db.ainconfig.rep_pen_range,
    typical_p: db.ainconfig.typical_p,
    badwords: db.ainconfig.badwords,
    model: aiModel === "novellist_damsel" ? "damsel" : "supertrin",
    stoptokens: ["「"].join("<<|>>") + db.ainconfig.stoptokens,
    logit_bias: logit_bias.length > 0 ? logit_bias.join("<<|>>") : undefined,
    logit_bias_values:
      logit_bias_values.length > 0 ? logit_bias_values.join("|") : undefined,
  };

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
  const unstr = unstringlizeAIN(result, formated, currentChar?.name ?? "");
  return {
    type: "multiline",
    result: unstr,
  };
}

