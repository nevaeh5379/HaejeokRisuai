import { Ollama } from "ollama/dist/browser.mjs";
import { fetchNative } from "../../globalApi.svelte";
import { LLMFormat } from "../../model/modellist";
import { getDatabase } from "../../storage/database.svelte";
import {
  DEFAULT_OLLAMA_CLOUD_CHAT_URL,
  resolveOllamaCloudTransportUrl,
} from "@risuai/chat-core/ollamaProvider.cjs";
import { unstringlizeChat } from "../stringlize";
import { requestClaude } from "./anthropic";
import type {
  RequestDataArgumentExtended,
  requestDataResponse,
} from "./request";
import type { StreamResponseChunk } from "./request";
import { shouldUseNodeOllamaCloudTransport } from "./ollamaTransport";
import { tryExecuteNodeProviderTransport } from "./nodeProviderExecutor";
import { requestOpenAI, requestOpenAIResponseAPI } from "./openAI/requests";
import { applyAdditionalParameters, getAdditionalParameters } from "./shared";

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

export async function requestOllama(
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
