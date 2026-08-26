import { language } from "../../../lang";
import { globalFetch } from "../../globalApi.svelte";
import { LLMFormat } from "../../model/modellist";
import { getCurrentCharacter, getDatabase } from "../../storage/database.svelte";
import { tokenizeNum } from "../../tokenizer";
import {
  buildNovelAIRequest,
  resolveNovelAIGenerateUrl,
} from "@risuai/chat-core/novelAIProvider.cjs";
import { stringlizeNAIChat } from "../models/nai";
import { unstringlizeChat } from "../stringlize";
import type {
  RequestDataArgumentExtended,
  requestDataResponse,
} from "./requestContracts";
import { tryExecuteNodeProviderTransport } from "./nodeProviderExecutor";
import { applyAdditionalParameters, getAdditionalParameters } from "./shared";

export async function requestNovelAI(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  const formated = arg.formated;
  const db = getDatabase();
  const aiModel = arg.aiModel;
  const temperature = arg.temperature;
  const maxTokens = arg.maxTokens;
  const biasString = arg.biasString;
  const currentChar = getCurrentCharacter();
  const prompt = stringlizeNAIChat(
    formated,
    currentChar?.name ?? "",
    arg.continue,
  );
  const abortSignal = arg.abortSignal;
  let logit_bias_exp: {
    sequence: number[];
    bias: number;
    ensure_sequence_finish: false;
    generate_once: true;
  }[] = [];

  if (arg.previewBody) {
    return {
      type: "success",
      result: JSON.stringify({
        error: "This model is not supported in preview mode",
      }),
    };
  }

  for (let i = 0; i < biasString.length; i++) {
    const bia = biasString[i];
    const tokens = await tokenizeNum(bia[0]);

    const tokensInNumberArray: number[] = [];

    for (const token of tokens) {
      tokensInNumberArray.push(token);
    }
    logit_bias_exp.push({
      sequence: tokensInNumberArray,
      bias: bia[1],
      ensure_sequence_finish: false,
      generate_once: true,
    });
  }

  const { variant, body: requestBody } = buildNovelAIRequest({
    prompt,
    modelId: aiModel ?? "",
    adventureMode: db.NAIadventure,
    temperature,
    maxTokens,
    settings: db.NAIsettings,
    logitBiasExp: logit_bias_exp,
  });
  let body = requestBody;

  let headers = {
    Authorization: "Bearer " + (arg.key ?? db.novelai.token),
  };

  body = applyAdditionalParameters(
    body,
    headers,
    getAdditionalParameters(aiModel),
  );

  const novelAIUrl = resolveNovelAIGenerateUrl(variant);
  if (!novelAIUrl) {
    return {
      type: "fail",
      result: "Unsupported NovelAI transport variant",
    };
  }
  const remoteTransport = await tryExecuteNodeProviderTransport(
    LLMFormat.NovelAI,
    { body, headers, variant },
    abortSignal,
  );
  const da =
    remoteTransport ??
    (await globalFetch(novelAIUrl, {
      body: body,
      headers: headers,
      abortSignal,
      chatId: arg.chatId,
    }));

  if (!da.ok || !da.data.output) {
    return {
      type: "fail",
      result: language.errors.httpError + `${JSON.stringify(da.data)}`,
    };
  }
  return {
    type: "success",
    result: unstringlizeChat(da.data.output, formated, currentChar?.name ?? ""),
  };
}

