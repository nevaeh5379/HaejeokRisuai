import { DEFAULT_OPENAI_CHAT_COMPLETIONS_URL } from "@risuai/chat-core/openAIProvider.cjs";
import { resolveNanoGPTTransportUrl } from "@risuai/chat-core/nanoGPTProvider.cjs";
import { globalFetch } from "src/ts/globalApi.svelte";
import { LLMFormat } from "src/ts/model/modellist";
import type {
  RequestDataArgumentExtended,
  requestDataResponse,
} from "../requestContracts";
import { tryExecuteNodeProviderTransport } from "../nodeProviderExecutor";
import { matchesNodeOllamaCloudEndpoint } from "../ollamaTransport";
import { interpretOpenAINonStreamingResponse } from "./nonStreamingResponse";
import type { LocalNetworkRequestOptions } from "./shared";

function resolveNodeOpenAINonStreamingTransport(
  replacerURL: string,
  format: LLMFormat,
): { format: LLMFormat; payload: Record<string, unknown> } | null {
  if (
    replacerURL === DEFAULT_OPENAI_CHAT_COMPLETIONS_URL &&
    format === LLMFormat.OpenAICompatible
  ) {
    return { format: LLMFormat.OpenAICompatible, payload: {} };
  }
  if (format === LLMFormat.NanoGPT) {
    for (const subscription of [false, true]) {
      if (replacerURL === resolveNanoGPTTransportUrl("chat", subscription)) {
        return {
          format: LLMFormat.NanoGPT,
          payload: { api: "chat", subscription },
        };
      }
    }
  }
  if (
    matchesNodeOllamaCloudEndpoint({
      requestURL: replacerURL,
      format,
      api: "openai-chat",
    })
  ) {
    return {
      format: LLMFormat.Ollama,
      payload: { api: "openai-chat" },
    };
  }
  return null;
}

export function shouldUseNodeOpenAINonStreamingTransport(
  replacerURL: string,
  format: LLMFormat,
): boolean {
  return resolveNodeOpenAINonStreamingTransport(replacerURL, format) !== null;
}

export async function requestHTTPOpenAI(
  replacerURL: string,
  body: any,
  headers: Record<string, string>,
  arg: RequestDataArgumentExtended,
  networkOptions: LocalNetworkRequestOptions = {},
): Promise<requestDataResponse> {
  const nodeTransport = resolveNodeOpenAINonStreamingTransport(
    replacerURL,
    arg.modelInfo.format,
  );
  const remoteTransport = nodeTransport
    ? await tryExecuteNodeProviderTransport(
        nodeTransport.format,
        { body, headers, ...nodeTransport.payload },
        arg.abortSignal,
      )
    : null;

  const response =
    remoteTransport ??
    (await globalFetch(replacerURL, {
      body,
      headers,
      abortSignal: arg.abortSignal,
      chatId: arg.chatId,
      interceptor: "openai_basic",
      networkRoute: networkOptions.networkRoute,
      requestTimeoutMs: networkOptions.requestTimeoutMs,
    }));
  return interpretOpenAINonStreamingResponse({
    ok: response.ok,
    data: response.data,
    body,
    arg,
    retry: () =>
      requestHTTPOpenAI(replacerURL, body, headers, arg, networkOptions),
  });
}
