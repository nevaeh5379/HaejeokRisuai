import { language } from "../../../lang";
import { globalFetch } from "../../globalApi.svelte";
import { risuChatParser } from "../../parser/parser.svelte";
import { getDatabase } from "../../storage/database.svelte";
import { OobaParams } from "../prompt";
import { getStopStrings, unstringlizeChat } from "../stringlize";
import { applyChatTemplate } from "../templates/chatTemplate";
import { resolveRequestCharacter } from "./requestContext";
import type {
  RequestDataArgumentExtended,
  requestDataResponse,
} from "./requestContracts";
import {
  applyAdditionalParameters,
  applyParameters,
  getAdditionalParameters,
} from "./shared";

export async function requestOobaLegacy(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  const formated = arg.formated;
  const db = getDatabase();
  const aiModel = arg.aiModel;
  const maxTokens = arg.maxTokens;
  const currentChar = resolveRequestCharacter(arg);
  const useStreaming = arg.useStreaming;
  const abortSignal = arg.abortSignal;
  let streamUrl = db.textgenWebUIStreamURL.replace(/\/api.*/, "/api/v1/stream");
  let blockingUrl = db.textgenWebUIBlockingURL.replace(
    /\/api.*/,
    "/api/v1/generate",
  );
  let bodyTemplate: { [key: string]: any } = {};
  const prompt = applyChatTemplate(formated, {
    currentChar,
    chatTarget: arg.triggerTarget,
  });
  let stopStrings = getStopStrings(false);
  if (db.localStopStrings) {
    stopStrings = db.localStopStrings.map((v) => {
      return risuChatParser(v.replace(/\\n/g, "\n"));
    });
  }

  bodyTemplate = {
    max_new_tokens: db.maxResponse,
    do_sample: db.ooba.do_sample,
    temperature: db.temperature / 100,
    top_p: db.ooba.top_p,
    typical_p: db.ooba.typical_p,
    repetition_penalty: db.ooba.repetition_penalty,
    encoder_repetition_penalty: db.ooba.encoder_repetition_penalty,
    top_k: db.ooba.top_k,
    min_length: db.ooba.min_length,
    no_repeat_ngram_size: db.ooba.no_repeat_ngram_size,
    num_beams: db.ooba.num_beams,
    penalty_alpha: db.ooba.penalty_alpha,
    length_penalty: db.ooba.length_penalty,
    early_stopping: false,
    truncation_length: maxTokens,
    ban_eos_token: db.ooba.ban_eos_token,
    stopping_strings: stopStrings,
    seed: -1,
    add_bos_token: db.ooba.add_bos_token,
    topP: db.top_p,
    prompt: prompt,
  };

  let headers: Record<string, string> =
    aiModel === "textgen_webui"
      ? {}
      : {
          "X-API-KEY": db.mancerHeader,
        };

  bodyTemplate = applyAdditionalParameters(
    bodyTemplate,
    headers,
    getAdditionalParameters(aiModel),
  );

  if (arg.previewBody) {
    return {
      type: "success",
      result: JSON.stringify({
        url: blockingUrl,
        body: bodyTemplate,
        headers: headers,
      }),
    };
  }

  if (useStreaming) {
    const oobaboogaSocket = new WebSocket(streamUrl);
    const statusCode = await new Promise((resolve) => {
      oobaboogaSocket.onopen = () => resolve(0);
      oobaboogaSocket.onerror = () => resolve(1001);
      oobaboogaSocket.onclose = ({ code }) => resolve(code);
    });
    if (abortSignal?.aborted || statusCode !== 0) {
      oobaboogaSocket.close();
      return {
        type: "fail",
        result:
          abortSignal?.reason ||
          `WebSocket connection failed to '${streamUrl}' failed!`,
      };
    }

    const close = () => {
      oobaboogaSocket.close();
    };
    const stream = new ReadableStream({
      start(controller) {
        let readed = "";
        oobaboogaSocket.onmessage = (event) => {
          const json = JSON.parse(event.data);
          if (json.event === "stream_end") {
            close();
            controller.close();
            return;
          }
          if (json.event !== "text_stream") return;
          readed += json.text;
          controller.enqueue(readed);
        };
        oobaboogaSocket.send(JSON.stringify(bodyTemplate));
      },
      cancel() {
        close();
      },
    });
    oobaboogaSocket.onerror = close;
    oobaboogaSocket.onclose = close;
    abortSignal?.addEventListener("abort", close);

    return {
      type: "streaming",
      result: stream,
    };
  }

  const res = await globalFetch(blockingUrl, {
    body: bodyTemplate,
    headers: headers,
    abortSignal,
    chatId: arg.chatId,
  });

  const dat = res.data as any;
  if (res.ok) {
    try {
      let result: string = dat.results[0].text ?? "";

      return {
        type: "success",
        result: unstringlizeChat(result, formated, currentChar?.name ?? ""),
      };
    } catch (error) {
      return {
        type: "fail",
        result: language.errors.httpError + `${error}`,
      };
    }
  } else {
    return {
      type: "fail",
      result: language.errors.httpError + `${JSON.stringify(res.data)}`,
    };
  }
}

export async function requestOoba(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  const formated = arg.formated;
  const db = getDatabase();
  const aiModel = arg.aiModel;
  const maxTokens = arg.maxTokens;
  const temperature = arg.temperature;
  const currentChar = resolveRequestCharacter(arg);
  const prompt = applyChatTemplate(formated, {
    currentChar,
    chatTarget: arg.triggerTarget,
  });
  let stopStrings = getStopStrings(false);
  if (db.localStopStrings) {
    stopStrings = db.localStopStrings.map((v) => {
      return risuChatParser(v.replace(/\\n/g, "\n"));
    });
  }
  let bodyTemplate: Record<string, any> = {
    prompt: prompt,
    presence_penalty: arg.PresensePenalty || db.PresensePenalty / 100,
    frequency_penalty: arg.frequencyPenalty || db.frequencyPenalty / 100,
    logit_bias: {},
    max_tokens: maxTokens,
    stop: stopStrings,
    temperature: temperature,
    top_p: db.top_p,
  };

  const url = new URL(db.textgenWebUIBlockingURL);
  url.pathname = "/v1/completions";
  const urlStr = url.toString();

  const OobaBodyTemplate = db.reverseProxyOobaArgs;
  const keys = Object.keys(OobaBodyTemplate);
  for (const key of keys) {
    if (
      OobaBodyTemplate[key] !== undefined &&
      OobaBodyTemplate[key] !== null &&
      OobaParams.includes(key)
    ) {
      bodyTemplate[key] = OobaBodyTemplate[key];
    } else if (bodyTemplate[key]) {
      delete bodyTemplate[key];
    }
  }

  let headers: Record<string, string> = {};
  bodyTemplate = applyAdditionalParameters(
    bodyTemplate,
    headers,
    getAdditionalParameters(aiModel),
  );

  if (arg.previewBody) {
    return {
      type: "success",
      result: JSON.stringify({
        url: urlStr,
        body: bodyTemplate,
        headers: headers,
      }),
    };
  }

  const response = await globalFetch(urlStr, {
    body: bodyTemplate,
    headers: headers,
    chatId: arg.chatId,
    abortSignal: arg.abortSignal,
  });

  if (!response.ok) {
    return {
      type: "fail",
      result: language.errors.httpError + `${JSON.stringify(response.data)}`,
    };
  }
  const text: string = response.data.choices[0].text ?? "";
  return {
    type: "success",
    result: text.replace(/##\n/g, ""),
  };
}

export async function requestKobold(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  const formated = arg.formated;
  const db = getDatabase();
  const maxTokens = arg.maxTokens;
  const abortSignal = arg.abortSignal;
  const currentChar = resolveRequestCharacter(arg);

  const prompt = applyChatTemplate(formated, {
    currentChar,
    chatTarget: arg.triggerTarget,
  });
  const url = new URL(db.koboldURL);
  if (url.pathname.length < 3) {
    url.pathname = "api/v1/generate";
  }

  let body = applyParameters(
    {
      prompt: prompt,
      max_length: maxTokens,
      max_context_length: db.maxContext,
      n: 1,
    },
    ["temperature", "top_p", "repetition_penalty", "top_k", "top_a"],
    {
      repetition_penalty: "rep_pen",
    },
    arg.mode,
    {
      modelId: arg.aiModel,
    },
  ) as KoboldGenerationInputSchema;

  let headers: Record<string, string> = {
    "content-type": "application/json",
  };

  body = applyAdditionalParameters(
    body,
    headers,
    getAdditionalParameters(arg.aiModel),
  ) as KoboldGenerationInputSchema;

  if (arg.previewBody) {
    return {
      type: "success",
      result: JSON.stringify({
        url: url.toString(),
        body: body,
        headers: headers,
      }),
    };
  }

  const da = await globalFetch(url.toString(), {
    method: "POST",
    body: body,
    headers: headers,
    abortSignal,
    chatId: arg.chatId,
  });

  if (!da.ok) {
    return {
      type: "fail",
      result: typeof da.data === "string" ? da.data : JSON.stringify(da.data),
      noRetry: true,
    };
  }

  const data = da.data;
  return {
    type: "success",
    result: data.results[0].text,
  };
}

export interface KoboldSamplerSettingsSchema {
  rep_pen?: number;
  rep_pen_range?: number;
  rep_pen_slope?: number;
  top_k?: number;
  top_a?: number;
  top_p?: number;
  tfs?: number;
  typical?: number;
  temperature?: number;
}

export interface KoboldGenerationInputSchema extends KoboldSamplerSettingsSchema {
  prompt: string;
  use_memory?: boolean;
  use_story?: boolean;
  use_authors_note?: boolean;
  use_world_info?: boolean;
  use_userscripts?: boolean;
  soft_prompt?: string;
  max_length?: number;
  max_context_length?: number;
  n: number;
  disable_output_formatting?: boolean;
  frmttriminc?: boolean;
  frmtrmblln?: boolean;
  frmtrmspch?: boolean;
  singleline?: boolean;
  disable_input_formatting?: boolean;
  frmtadsnsp?: boolean;
  quiet?: boolean;
  sampler_order?: number[];
  sampler_seed?: number;
  sampler_full_determinism?: boolean;
}
