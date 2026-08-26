import { Ollama } from "ollama/dist/browser.mjs";
import { language } from "../../../lang";
import { fetchNative } from "../../globalApi.svelte";
import {
  getModelInfo,
  LLMFormat,
  type LLMModel,
} from "../../model/modellist";
import {
  getDatabase,
  type character,
} from "../../storage/database.svelte";
import { sleep } from "../../util";
import { formatProviderMessages } from "@risuai/chat-core/providerPrompt.cjs";
import { prepareProviderExecutionContext } from "@risuai/chat-core/providerContext.cjs";
import type {
  ChatModelResponse,
  ChatStreamChunk,
  OpenAIChat,
} from "@risuai/chat-core/types.cjs";
import type { MCPTool } from "../mcp/mcplib";
import {
  DEFAULT_OLLAMA_CLOUD_CHAT_URL,
  resolveOllamaCloudTransportUrl,
} from "@risuai/chat-core/ollamaProvider.cjs";
import { unstringlizeChat } from "../stringlize";
import { requestClaude } from "./anthropic";
import { requestGoogleCloudVertex } from "./google";
import { requestHorde } from "./horde";
import { requestNovelAI } from "./novelAI";
import { requestNovelList } from "./novelList";
import { requestCohere } from "./cohere";
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
