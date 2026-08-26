import { Ollama } from "ollama/dist/browser.mjs";
import { language } from "../../../lang";
import { fetchNative, globalFetch } from "../../globalApi.svelte";
import {
  getModelInfo,
  LLMFormat,
  type LLMModel,
} from "../../model/modellist";
import { risuChatParser } from "../../parser/parser.svelte";
import {
  getCurrentCharacter,
  getDatabase,
  type character,
} from "../../storage/database.svelte";
import { tokenizeNum } from "../../tokenizer";
import { sleep } from "../../util";
import { formatProviderMessages } from "@risuai/chat-core/providerPrompt.cjs";
import { prepareProviderExecutionContext } from "@risuai/chat-core/providerContext.cjs";
import type {
  ChatModelResponse,
  ChatStreamChunk,
  OpenAIChat,
} from "@risuai/chat-core/types.cjs";
import type { MCPTool } from "../mcp/mcplib";
import { DEFAULT_COHERE_CHAT_URL } from "@risuai/chat-core/cohereProvider.cjs";
import { resolveNovelAIGenerateUrl } from "@risuai/chat-core/novelAIProvider.cjs";
import { DEFAULT_NOVELLIST_API_URL } from "@risuai/chat-core/novelListProvider.cjs";
import {
  DEFAULT_OLLAMA_CLOUD_CHAT_URL,
  resolveOllamaCloudTransportUrl,
} from "@risuai/chat-core/ollamaProvider.cjs";
import {
  STABLE_HORDE_TEXT_ASYNC_URL,
  buildStableHordeStatusUrl,
} from "@risuai/chat-core/hordeProvider.cjs";
import { NovelAIBadWordIds, stringlizeNAIChat } from "../models/nai";
import {
  getStopStrings,
  stringlizeAINChat,
  unstringlizeAIN,
  unstringlizeChat,
} from "../stringlize";
import { applyChatTemplate } from "../templates/chatTemplate";
import { requestClaude } from "./anthropic";
import { requestGoogleCloudVertex } from "./google";
import { BrowserProviderExecutor } from "./browserProviderExecutor";
import { requestPlugin, requestWebLLM } from "./browserRuntimeProviders";
import {
  requestKobold,
  requestOoba,
  requestOobaLegacy,
} from "./localEndpointProviders";
import { shouldUseNodeOllamaCloudTransport } from "./ollamaTransport";
import {
  tryExecuteNodeProvider,
  tryExecuteNodeProviderTransport,
} from "./nodeProviderExecutor";
import {
  requestOpenAI,
  requestOpenAILegacyInstruct,
  requestOpenAIResponseAPI,
} from "./openAI/requests";
import {
  applyAdditionalParameters,
  applyParameters,
  getAdditionalParameters,
  type ModelModeExtended,
} from "./shared";

export type ToolCall = {
  name: string;
  arguments: string;
};

export interface requestDataArgument {
  formated: OpenAIChat[];
  bias: { [key: number]: number };
  biasString?: [string, number][];
  currentChar?: character;
  temperature?: number;
  maxTokens?: number;
  PresensePenalty?: number;
  frequencyPenalty?: number;
  useStreaming?: boolean;
  forceStreaming?: boolean;
  isGroupChat?: boolean;
  useEmotion?: boolean;
  continue?: boolean;
  chatId?: string;
  noMultiGen?: boolean;
  schema?: string;
  extractJson?: string;
  imageResponse?: boolean;
  previewBody?: boolean;
  staticModel?: string;
  escape?: boolean;
  tools?: MCPTool[];
  rememberToolUsage?: boolean;
  blockPlugins?: boolean;
}

export interface RequestDataArgumentExtended extends requestDataArgument {
  aiModel?: string;
  multiGen?: boolean;
  abortSignal?: AbortSignal;
  modelInfo?: LLMModel;
  customURL?: string;
  mode?: ModelModeExtended;
  key?: string;
  additionalOutput?: string;
  saveSignatures?: boolean;
}

export type requestDataResponse = ChatModelResponse;
export type StreamResponseChunk = ChatStreamChunk;

type OllamaThinkMode = boolean | "low" | "medium" | "high";

function getOllamaThinkMode(mode: string): OllamaThinkMode | undefined {
  switch (mode) {
    case "off":
      return false;
    case "on":
      return true;
    case "low":
    case "medium":
    case "high":
      return mode;
    default:
      return undefined;
  }
}

function formatThinkingOutput(thinking: string, content: string): string {
  return thinking
    ? `<Thoughts>\n${thinking}\n</Thoughts>\n\n${content}`
    : content;
}

function normalizeFetchHeaders(headers?: HeadersInit): {
  [key: string]: string;
} {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return headers as { [key: string]: string };
}

async function ollamaCloudFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const url = input instanceof Request ? input.url : input.toString();
  const method = (init.method ??
    (input instanceof Request ? input.method : "GET")) as
    "POST" | "GET" | "PUT" | "DELETE";
  const headers = normalizeFetchHeaders(
    init.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const body =
    init.body ??
    (input instanceof Request ? await input.arrayBuffer() : undefined);

  const response = await fetchNative(url, {
    body: body as string | Uint8Array | ArrayBuffer | undefined,
    headers,
    method,
    signal: init.signal as AbortSignal,
    interceptor: "ollama_sdk",
  });

  return normalizeOllamaStreamResponse(response);
}

function normalizeOllamaStreamResponse(response: Response): Response {
  if (!response.body) {
    return response;
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let depth = 0;
  let inString = false;
  let escaped = false;

  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        let out = "";
        const text = decoder.decode(chunk, { stream: true });

        for (const char of text) {
          out += char;

          if (escaped) {
            escaped = false;
            continue;
          }
          if (char === "\\" && inString) {
            escaped = true;
            continue;
          }
          if (char === '"') {
            inString = !inString;
            continue;
          }
          if (inString) {
            continue;
          }
          if (char === "{") {
            depth++;
            continue;
          }
          if (char === "}") {
            depth = Math.max(0, depth - 1);
            if (depth === 0) {
              out += "\n";
            }
          }
        }

        if (out) {
          controller.enqueue(encoder.encode(out));
        }
      },
    }),
  );

  return new Response(stream, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

const browserProviderExecutor = new BrowserProviderExecutor<RequestDataArgumentExtended>(
  {
    openai: requestOpenAI,
    "openai-responses": requestOpenAIResponseAPI,
    "openai-legacy": requestOpenAILegacyInstruct,
    anthropic: requestClaude,
    google: requestGoogleCloudVertex,
    novelai: requestNovelAI,
    novellist: requestNovelList,
    cohere: requestCohere,
    "ooba-legacy": requestOobaLegacy,
    ooba: requestOoba,
    plugin: requestPlugin,
    kobold: requestKobold,
    ollama: requestOllama,
    horde: requestHorde,
    webllm: requestWebLLM,
    echo: requestEcho,
  },
  () => language.errors.unknownModel,
);

export async function requestChatDataMain(
  arg: requestDataArgument,
  model: ModelModeExtended,
  abortSignal: AbortSignal = null,
): Promise<requestDataResponse> {
  const db = getDatabase();
  const targ: RequestDataArgumentExtended = arg;

  const prepared = prepareProviderExecutionContext(
    { ...arg, mode: model },
    {
      primaryModel: db.aiModel,
      subModel: db.subModel,
      separateModelsForAxModels: db.seperateModelsForAxModels,
      separateModels: db.seperateModels,
      maxResponseTokens: db.maxResponse,
      temperaturePercent: db.temperature,
      useStreaming: db.useStreaming,
      genTime: db.genTime,
      extractJson: db.extractJson,
      reverseProxy: {
        requestModel: db.customProxyRequestModel,
        format: db.customAPIFormat,
        url: db.forceReplaceUrl,
        key: db.proxyKey,
      },
      customModels: db.customModels,
    },
    getModelInfo,
  );

  if (prepared.pluginBlocked) {
    return {
      type: "fail",
      result: "Plugin calls are blocked by the caller.",
    };
  }

  Object.assign(targ, prepared);
  targ.formated = safeStructuredClone(arg.formated);
  targ.bias = arg.bias;
  targ.currentChar = arg.currentChar;
  targ.abortSignal = abortSignal;
  targ.mode = model;

  const format = targ.modelInfo.format;

  targ.formated = formatProviderMessages(targ.formated, targ.modelInfo.flags, {
    systemContentReplacement: db.systemContentReplacement,
    systemRoleReplacement: db.systemRoleReplacement,
  });

  return browserProviderExecutor.execute(format, targ);
}

async function requestNovelAI(
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

async function requestEcho(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  const db = getDatabase();
  const delay = db.echoDelay ?? 0;
  const message = db.echoMessage ?? "Echo Message";
  const remote = await tryExecuteNodeProvider(arg.modelInfo?.format ?? LLMFormat.Echo, {
    message,
    delayMs: Math.max(0, Math.round(delay * 1000)),
  });
  if (remote) return remote;

  if (delay > 0) {
    await sleep(delay * 1000);
  }

  return {
    type: "success",
    result: message,
  };
}

async function requestNovelList(
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

async function requestOllama(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  const formated = arg.formated;
  const db = getDatabase();
  const isCloud = arg.aiModel === "ollama-cloud";
  const requestFormat = isCloud ? db.ollamaRequestFormat : LLMFormat.Ollama;
  const ollamaModel = isCloud ? db.ollamaCloudModel : db.ollamaModel;
  const ollamaThinkMode = getOllamaThinkMode(db.ollamaThinkingMode);

  if (isCloud && requestFormat === LLMFormat.OpenAICompatible) {
    arg.customURL = resolveOllamaCloudTransportUrl("openai-chat")!;
    arg.key = db.ollamaApiKey;
    arg.modelInfo.internalID = ollamaModel;
    return requestOpenAI(arg);
  }

  if (isCloud && requestFormat === LLMFormat.OpenAIResponseAPI) {
    arg.customURL = resolveOllamaCloudTransportUrl("responses")!;
    arg.key = db.ollamaApiKey;
    arg.modelInfo.internalID = ollamaModel;
    return requestOpenAIResponseAPI(arg);
  }

  if (isCloud && requestFormat === LLMFormat.Anthropic) {
    arg.customURL = resolveOllamaCloudTransportUrl("anthropic")!;
    arg.key = db.ollamaApiKey;
    arg.modelInfo = {
      ...arg.modelInfo,
      internalID: ollamaModel,
      parameters: ["temperature", "top_k", "top_p"],
    };
    return requestClaude(arg);
  }

  const messages: any[] = [];
  for (const v of formated) {
    if (v.role === "assistant" || v.role === "user" || v.role === "system") {
      messages.push({
        role: v.role,
        content: v.content,
      });
    }
  }

  let customHeaders: Record<string, string> =
    isCloud && db.ollamaApiKey
      ? { Authorization: "Bearer " + db.ollamaApiKey }
      : {};

  let requestBody: any = {
    model: ollamaModel,
    messages: messages,
    stream: arg.useStreaming,
    think: ollamaThinkMode,
  };

  requestBody = applyAdditionalParameters(
    requestBody,
    customHeaders,
    getAdditionalParameters(arg.aiModel),
  );

  if (arg.previewBody) {
    return {
      type: "success",
      result: JSON.stringify({
        url: isCloud
          ? DEFAULT_OLLAMA_CLOUD_CHAT_URL
          : `${db.ollamaURL}/api/chat`,
        model: ollamaModel,
        source: db.ollamaModelSource,
        stream: arg.useStreaming,
        think: ollamaThinkMode,
        headers:
          Object.keys(customHeaders).length > 0 ? customHeaders : undefined,
        body: requestBody,
      }),
    };
  }

  const ollama = new Ollama({
    host: isCloud ? "https://ollama.com" : db.ollamaURL,
    headers: Object.keys(customHeaders).length > 0 ? customHeaders : undefined,
    fetch: isCloud ? ollamaCloudFetch : undefined,
  });

  if (!arg.useStreaming) {
    requestBody.stream = false;
    const remoteTransport = shouldUseNodeOllamaCloudTransport({
      isCloud,
      requestFormat,
      useStreaming: arg.useStreaming,
    })
      ? await tryExecuteNodeProviderTransport(
          LLMFormat.Ollama,
          {
            api: "native",
            body: requestBody,
            headers: {
              "Content-Type": "application/json",
              ...customHeaders,
            },
          },
          arg.abortSignal,
        )
      : null;
    if (remoteTransport && !remoteTransport.ok) {
      return {
        type: "fail",
        result:
          typeof remoteTransport.data === "string"
            ? remoteTransport.data
            : JSON.stringify(remoteTransport.data),
        model: arg.aiModel,
      };
    }
    const response: any = remoteTransport?.data ?? (await ollama.chat(requestBody));

    const result = formatThinkingOutput(
      response.message?.thinking ?? "",
      response.message?.content ?? "",
    );
    return {
      type: "success",
      result: unstringlizeChat(result, formated, arg.currentChar?.name ?? ""),
      model: arg.aiModel,
    };
  }

  requestBody.stream = true;
  const response: any = await ollama.chat(requestBody);

  const readableStream = new ReadableStream<StreamResponseChunk>({
    async start(controller) {
      let content = "";
      let thinking = "";
      for await (const chunk of response) {
        thinking += chunk.message?.thinking ?? "";
        content += chunk.message?.content ?? "";
        controller.enqueue({
          "0": formatThinkingOutput(thinking, content),
        });
      }
      controller.close();
    },
  });

  return {
    type: "streaming",
    result: readableStream,
    model: arg.aiModel,
  };
}

async function requestCohere(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  const formated = arg.formated;
  const db = getDatabase();
  const aiModel = arg.aiModel;

  let lastChatPrompt = "";
  let preamble = "";

  let lastChat = formated[formated.length - 1];
  if (lastChat.role === "user") {
    lastChatPrompt = lastChat.content;
    formated.pop();
  } else {
    while (lastChat.role !== "user") {
      lastChat = formated.pop();
      if (!lastChat) {
        return {
          type: "fail",
          result: "Cohere requires a user message to generate a response",
        };
      }
      lastChatPrompt =
        (lastChat.role === "user" ? "" : `${lastChat.role}: `) +
        "\n" +
        lastChat.content +
        lastChatPrompt;
    }
  }

  const firstChat = formated[0];
  if (firstChat.role === "system") {
    preamble = firstChat.content;
    formated.shift();
  }

  //reformat chat

  let body = applyParameters(
    {
      message: lastChatPrompt,
      chat_history: formated
        .map((v) => {
          if (v.role === "assistant") {
            return {
              role: "CHATBOT",
              message: v.content,
            };
          }
          if (v.role === "system") {
            return {
              role: "SYSTEM",
              message: v.content,
            };
          }
          if (v.role === "user") {
            return {
              role: "USER",
              message: v.content,
            };
          }
          return null;
        })
        .filter((v) => v !== null)
        .filter((v) => {
          return v.message;
        }),
    },
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

  if (
    aiModel !== "cohere-command-r-03-2024" &&
    aiModel !== "cohere-command-r-plus-04-2024"
  ) {
    body.safety_mode = "NONE";
  }

  if (preamble) {
    if (body.chat_history.length > 0) {
      body.preamble = preamble;
    } else {
      body.message = `system: ${preamble}`;
    }
  }

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

  if (!res.ok) {
    return {
      type: "fail",
      result: JSON.stringify(res.data),
    };
  }

  const result = res?.data?.text;
  if (!result) {
    return {
      type: "fail",
      result: JSON.stringify(res.data),
    };
  }

  return {
    type: "success",
    result: result,
  };
}

async function requestHorde(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  const formated = arg.formated;
  const db = getDatabase();
  const aiModel = arg.aiModel;
  const currentChar = getCurrentCharacter();
  const abortSignal = arg.abortSignal;

  if (arg.previewBody) {
    return {
      type: "success",
      result: JSON.stringify({
        error: "Preview body is not supported for Horde",
      }),
    };
  }

  const prompt = applyChatTemplate(formated);

  const realModel = aiModel.split(":::")[1];

  const argument = {
    prompt: prompt,
    params: {
      n: 1,
      max_context_length: db.maxContext + 100,
      max_length: db.maxResponse,
      singleline: false,
      temperature: db.temperature / 100,
      top_k: db.top_k,
      top_p: db.top_p,
    },
    trusted_workers: false,
    workerslow_workers: true,
    _blacklist: false,
    dry_run: false,
    models: [realModel, realModel.trim(), " " + realModel, realModel + " "],
  };

  if (realModel === "auto") {
    delete argument.models;
  }

  let apiKey = "0000000000";
  if (db.hordeConfig.apiKey.length > 2) {
    apiKey = db.hordeConfig.apiKey;
  }

  let headers: Record<string, string> = {
    "content-type": "application/json",
    apikey: apiKey,
  };

  let finalBody = applyAdditionalParameters(
    argument,
    headers,
    getAdditionalParameters(arg.aiModel),
  );

  const remote = await tryExecuteNodeProvider(
    LLMFormat.Horde,
    {
      body: finalBody,
      headers,
    },
    abortSignal,
  );
  if (remote) {
    if (remote.type !== "success") return remote;
    return {
      ...remote,
      result: unstringlizeChat(
        remote.result,
        formated,
        currentChar?.name ?? "",
      ),
    };
  }

  const da = await fetch(STABLE_HORDE_TEXT_ASYNC_URL, {
    body: JSON.stringify(finalBody),
    method: "POST",
    headers: headers,
    signal: abortSignal,
  });

  if (da.status !== 202) {
    return {
      type: "fail",
      result: await da.text(),
    };
  }

  const json: {
    id: string;
    kudos: number;
    message: string;
  } = await da.json();

  let warnMessage = "";
  if (json.message) {
    warnMessage = "with " + json.message;
  }
  const statusUrl = buildStableHordeStatusUrl(json.id);
  if (!statusUrl) {
    return {
      type: "fail",
      result: "Invalid Horde generation id",
      noRetry: true,
    };
  }

  try {
    while (true) {
      await sleep(2000);
      abortSignal?.throwIfAborted?.();
      const data = await (
        await fetch(statusUrl, { signal: abortSignal })
      ).json();
      if (!data.is_possible) {
        fetch(statusUrl, {
          method: "DELETE",
        });
        return {
          type: "fail",
          result: "Response not possible" + warnMessage,
          noRetry: true,
        };
      }
      if (
        data.done &&
        Array.isArray(data.generations) &&
        data.generations.length > 0
      ) {
        const generations: { text: string }[] = data.generations;
        if (generations && generations.length > 0) {
          return {
            type: "success",
            result: unstringlizeChat(
              generations[0].text ?? "",
              formated,
              currentChar?.name ?? "",
            ),
          };
        }
        return {
          type: "fail",
          result: "No Generations when done",
          noRetry: true,
        };
      }
    }
  } catch (error) {
    if (abortSignal?.aborted) {
      try {
        await fetch(statusUrl, { method: "DELETE" });
      } catch {}
    }
    throw error;
  }
}
