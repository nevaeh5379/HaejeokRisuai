import { language } from "../../../lang";
import { globalFetch } from "../../globalApi.svelte";
import { LLMFormat } from "../../model/modellist";
import { getCurrentCharacter, getDatabase } from "../../storage/database.svelte";
import { tokenizeNum } from "../../tokenizer";
import { resolveNovelAIGenerateUrl } from "@risuai/chat-core/novelAIProvider.cjs";
import { NovelAIBadWordIds, stringlizeNAIChat } from "../models/nai";
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

  let prefix = "vanilla";

  if (db.NAIadventure) {
    prefix = "theme_textadventure";
  }

  const gen = db.NAIsettings;
  const payload = {
    temperature: temperature,
    max_length: maxTokens,
    min_length: 1,
    top_k: gen.topK,
    top_p: gen.topP,
    top_a: gen.topA,
    tail_free_sampling: gen.tailFreeSampling,
    repetition_penalty: gen.repetitionPenalty,
    repetition_penalty_range: gen.repetitionPenaltyRange,
    repetition_penalty_slope: gen.repetitionPenaltySlope,
    repetition_penalty_frequency: gen.frequencyPenalty,
    repetition_penalty_presence: gen.presencePenalty,
    generate_until_sentence: true,
    use_cache: false,
    use_string: true,
    return_full_text: false,
    prefix: prefix,
    order: [6, 2, 3, 0, 4, 1, 5, 8],
    typical_p: gen.typicalp,
    repetition_penalty_whitelist: [
      49256, 49264, 49231, 49230, 49287, 85, 49255, 49399, 49262, 336, 333, 432,
      363, 468, 492, 745, 401, 426, 623, 794, 1096, 2919, 2072, 7379, 1259,
      2110, 620, 526, 487, 16562, 603, 805, 761, 2681, 942, 8917, 653, 3513,
      506, 5301, 562, 5010, 614, 10942, 539, 2976, 462, 5189, 567, 2032, 123,
      124, 125, 126, 127, 128, 129, 130, 131, 132, 588, 803, 1040, 49209, 4, 5,
      6, 7, 8, 9, 10, 11, 12,
    ],
    stop_sequences: [[49287], [49405]],
    bad_words_ids: NovelAIBadWordIds,
    logit_bias_exp: logit_bias_exp,
    mirostat_lr: gen.mirostat_lr ?? 1,
    mirostat_tau: gen.mirostat_tau ?? 0,
    cfg_scale: gen.cfg_scale ?? 1,
    cfg_uc: "",
  };

  const variant = aiModel === "novelai_kayra" ? "kayra" : "clio";
  let body = {
    input: prompt,
    model: variant === "kayra" ? "kayra-v1" : "clio-v1",
    parameters: payload,
  };

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

