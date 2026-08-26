import {
  addFetchLog,
  fetchNative,
  textifyReadableStream,
} from "src/ts/globalApi.svelte";
import { isNodeServer, isTauri } from "src/ts/platform";
import type {
  RequestDataArgumentExtended,
  requestDataResponse,
} from "../requestContracts";
import { getTranStream, wrapToolStream } from "./streamingResponse";
import type { LocalNetworkRequestOptions } from "./shared";

export function isBrowserBlockedOpenAIStreamingUrl(
  url: string,
  environment = { isTauri, isNodeServer },
): boolean {
  const urlHost = new URL(url).host;
  const isLocal =
    urlHost.includes("localhost") ||
    urlHost.includes("172.0.0.1") ||
    urlHost.includes("0.0.0.0");
  return isLocal && !environment.isTauri && !environment.isNodeServer;
}
export async function requestOpenAIStreamingTransport(
  replacerURL: string,
  body: Record<string, any>,
  headers: Record<string, string>,
  arg: RequestDataArgumentExtended,
  networkOptions: LocalNetworkRequestOptions = {},
): Promise<requestDataResponse> {
  body.stream = true;
  if (isBrowserBlockedOpenAIStreamingUrl(replacerURL)) {
    return {
      type: "fail",
      result:
        "You are trying local request on streaming. this is not allowed dude to browser/os security policy. turn off streaming.",
    };
  }

  if (arg.previewBody) {
    return {
      type: "success",
      result: JSON.stringify({
        url: replacerURL,
        body,
        headers,
      }),
    };
  }
  const response = await fetchNative(replacerURL, {
    body: JSON.stringify(body),
    method: "POST",
    headers,
    signal: arg.abortSignal,
    chatId: arg.chatId,
    interceptor: "openai_streaming",
    networkRoute: networkOptions.networkRoute,
    requestTimeoutMs: networkOptions.requestTimeoutMs,
  });

  if (response.status !== 200) {
    return {
      type: "fail",
      result: await textifyReadableStream(response.body),
    };
  }

  if (!response.headers.get("Content-Type").includes("text/event-stream")) {
    return {
      type: "fail",
      result: await textifyReadableStream(response.body),
    };
  }
  addFetchLog({
    body,
    response: "Streaming",
    success: true,
    url: replacerURL,
    status: response.status,
  });

  const transtream = getTranStream(arg);
  response.body.pipeTo(transtream.writable);

  return {
    type: "streaming",
    result: wrapToolStream(
      transtream.readable,
      body,
      headers,
      replacerURL,
      arg,
      networkOptions,
    ),
  };
}
