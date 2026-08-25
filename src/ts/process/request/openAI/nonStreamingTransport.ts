import { DEFAULT_OPENAI_CHAT_COMPLETIONS_URL } from "@risuai/chat-core/openAIProvider.cjs";
import { globalFetch } from "src/ts/globalApi.svelte";
import { LLMFormat } from "src/ts/model/modellist";
import type {
  RequestDataArgumentExtended,
  requestDataResponse,
} from "../request";
import { tryExecuteNodeProviderTransport } from "../nodeProviderExecutor";
import { interpretOpenAINonStreamingResponse } from "./nonStreamingResponse";
import type { LocalNetworkRequestOptions } from "./shared";

export function shouldUseNodeOpenAINonStreamingTransport(
  replacerURL: string,
  format: LLMFormat,
): boolean {
  return (
    replacerURL === DEFAULT_OPENAI_CHAT_COMPLETIONS_URL &&
    format === LLMFormat.OpenAICompatible
  );
}

export async function requestHTTPOpenAI(
  replacerURL: string,
  body: any,
  headers: Record<string, string>,
  arg: RequestDataArgumentExtended,
  networkOptions: LocalNetworkRequestOptions = {},
): Promise<requestDataResponse> {
  const remoteTransport = shouldUseNodeOpenAINonStreamingTransport(
    replacerURL,
    arg.modelInfo.format,
  )
    ? await tryExecuteNodeProviderTransport(
        LLMFormat.OpenAICompatible,
        { body, headers },
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
