import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { language } from "../../../lang";
import { globalFetch } from "../../globalApi.svelte";
import { LLMFormat } from "../../model/modellist";

import { tokenizeNum } from "../../tokenizer";
import {
  buildNovelAIRequest,
  resolveNovelAIGenerateUrl,
} from "@risuai/chat-core/novelAIProvider.ts";
import { stringlizeNAIChat } from "../models/nai";
import { unstringlizeChat } from "../stringlize";
import { resolveRequestCharacter } from "./requestContext";
import type {
  RequestDataArgumentExtended,
  requestDataResponse,
} from "./requestContracts";
import { tryExecuteNodeProviderTransport } from "./nodeProviderExecutor";
import { applyAdditionalParameters, getAdditionalParameters } from "./shared";

/**
 * Builds a NovelAI text request with template/bias settings and previews or executes its transport.
 *
 * 한국어: 템플릿·바이어스 설정으로 NovelAI 텍스트 요청을 구성해 미리보기 또는 전송을 처리하는 함수.
 *
 * @param arg - Provider arguments including optional request-preview mode. / 선택적 요청 미리보기 모드를 포함한 제공자 인자.
 * @remarks
 * Preview returns the resolved URL, final body and headers for detached Node illustration work.
 * The preview may contain credentials and must not be persisted in chat metadata.
 * 한국어: 미리보기는 독립 Node 삽화 작업에 사용할 실제 URL·최종 본문·헤더를 반환.
 * 인증 정보가 포함될 수 있으므로 채팅 메타데이터에 저장 금지.
 */
export async function requestNovelAI(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  const formated = arg.formated;
  const db = settingsStore.state;
  const aiModel = arg.aiModel;
  const temperature = arg.temperature;
  const maxTokens = arg.maxTokens;
  const biasString = arg.biasString;
  const currentChar = resolveRequestCharacter(arg);
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
    adventureMode: presetStore.state.NAIadventure,
    temperature,
    maxTokens,
    settings: presetStore.state.NAIsettings,
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
  if (arg.previewBody)
    return {
      type: "success",
      result: JSON.stringify({ url: novelAIUrl, body, headers }),
    };

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
    result: unstringlizeChat(
      da.data.output,
      formated,
      currentChar?.name ?? "",
      arg.triggerTarget,
    ),
  };
}
