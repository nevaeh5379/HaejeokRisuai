import { normalizeOpenAIProviderMessages } from "@risuai/chat-core/openAIProvider.cjs";
import { prepareOpenAILogitBias } from "./biasPreparation";
import { prepareOpenAIProviderMessages } from "./messagePreparation";
import { requestMistral } from "./mistralRequest";
import { prepareModernOpenAIRequest } from "./modernRequestPreparation";
import { requestHTTPOpenAI } from "./nonStreamingTransport";
import { requestOpenAIStreamingTransport } from "./streamingTransport";
import { getDatabase } from "src/ts/storage/database.svelte";
import { LLMFlags, LLMFormat } from "src/ts/model/modellist";
import type {
  RequestDataArgumentExtended,
  requestDataResponse,
} from "../request";
import type { OpenAIChatExtra } from "./types";
export { requestOpenAIResponseAPI, __testResponsesAPI } from "./responses";
export { requestHTTPOpenAI } from "./nonStreamingTransport";
export { requestOpenAILegacyInstruct } from "./legacyInstruct";
export async function requestOpenAI(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  const formated = arg.formated;
  const db = getDatabase();
  const aiModel = arg.aiModel;
  let formatedChat = await prepareOpenAIProviderMessages(
    formated as OpenAIChatExtra[],
    db.gptVisionQuality,
  );

  formatedChat = normalizeOpenAIProviderMessages(formatedChat, {
    newOAIHandle: db.newOAIHandle,
    deepSeekPrefix: arg.modelInfo.flags.includes(LLMFlags.deepSeekPrefix),
    deepSeekThinkingInput: arg.modelInfo.flags.includes(
      LLMFlags.deepSeekThinkingInput,
    ),
    reverseProxyOobaMode:
      aiModel === "reverse_proxy" && db.reverseProxyOobaMode,
    developerRole: arg.modelInfo.flags.includes(LLMFlags.DeveloperRole),
  });

  arg.bias = await prepareOpenAILogitBias(arg.biasString, arg.bias);

  console.log(formatedChat);
  if (arg.modelInfo.format === LLMFormat.Mistral) {
    return requestMistral(arg, formatedChat);
  }

  const prepared = await prepareModernOpenAIRequest(arg, formatedChat);
  if (prepared.ok === false) {
    return { type: "fail", result: prepared.error };
  }

  const {
    body,
    headers,
    replacerURL,
    localNetworkOptions,
    streamingLocalNetworkOptions,
  } = prepared;

  if (arg.useStreaming) {
    return requestOpenAIStreamingTransport(
      replacerURL,
      body,
      headers,
      arg,
      streamingLocalNetworkOptions,
    );
  }

  if (arg.previewBody) {
    return {
      type: "success",
      result: JSON.stringify({ url: replacerURL, body, headers }),
    };
  }

  return requestHTTPOpenAI(
    replacerURL,
    body,
    headers,
    arg,
    localNetworkOptions,
  );

}
