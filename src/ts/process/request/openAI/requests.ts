import {
  applyOpenAIPostParameterBodyPolicies,
  applyOpenAIPreParameterBodyPolicies,
  buildOpenAIRequestHeaders,
  normalizeOpenAIProviderMessages,
  resolveOpenAIRequestEndpoint,
  resolveOpenAIRequestModel,
  shouldUseOpenAIFlexProcessing,
} from "@risuai/chat-core/openAIProvider.cjs";
import { prepareOpenAILogitBias } from "./biasPreparation";
import { prepareOpenAIProviderMessages } from "./messagePreparation";
import { requestMistral } from "./mistralRequest";
import { requestHTTPOpenAI } from "./nonStreamingTransport";
import { requestOpenAIStreamingTransport } from "./streamingTransport";
import { getDatabase } from "src/ts/storage/database.svelte";
import { LLMFlags, LLMFormat, LLMProvider } from "src/ts/model/modellist";
import { getFreeOpenRouterModels } from "src/ts/model/openrouter";
import { simplifySchema } from "src/ts/util";

import { getOpenAIJSONSchema } from "../../templates/jsonSchema";
import { applyChatTemplate } from "../../templates/chatTemplate";
import { supportsInlayImage } from "../../files/inlays";
import type {
  RequestDataArgumentExtended,
  requestDataResponse,
} from "../request";
import {
  applyAdditionalParameters,
  applyParameters,
  getAdditionalParameters,
} from "../shared";

import type { OpenAIChatExtra } from "./types";

import { getLocalNetworkRequestOptions } from "./shared";
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

  let openrouterRequestModel = db.openrouterRequestModel;
  if (aiModel === "openrouter" && db.openrouterRequestModel === "risu/free") {
    openrouterRequestModel = await getFreeOpenRouterModels();
  }

  console.log(formatedChat);
  if (arg.modelInfo.format === LLMFormat.Mistral) {
    return requestMistral(arg, formatedChat);
  }

  db.cipherChat = false;
  let body: {
    [key: string]: any;
  } = {
    model: resolveOpenAIRequestModel({
      aiModel,
      requestModel:
        aiModel === "reverse_proxy" ? db.customProxyRequestModel : aiModel,
      openRouterRequestModel: openrouterRequestModel,
      nanoGPTRequestModel: db.nanogptRequestModel,
      internalID: arg.modelInfo.internalID,
    }),
    messages: formatedChat,
    max_tokens: arg.maxTokens,
    logit_bias: arg.bias,
    stream: false,
  };

  body = applyOpenAIPreParameterBodyPolicies(body, {
    useCompletionTokens: arg.modelInfo.flags.includes(
      LLMFlags.OAICompletionTokens,
    ),
    generationSeed: db.generationSeed,
    responseJsonSchema:
      (db.jsonSchemaEnabled || arg.schema) &&
      !arg.modelInfo.flags.includes(LLMFlags.noStructuredOutput)
        ? getOpenAIJSONSchema(arg.schema)
        : undefined,
    prediction: db.OAIPrediction,
    aiModel,
    openRouterFallback: db.openrouterFallback,
    openRouterMiddleOut: db.openrouterMiddleOut,
    openRouterProvider: db.openrouterProvider,
    instructPrompt:
      aiModel === "openrouter" && db.useInstructPrompt
        ? applyChatTemplate(formated)
        : undefined,
  });

  body = applyParameters(body, arg.modelInfo.parameters, {}, arg.mode, {
    modelId: arg.modelInfo.id,
  });

  const hasTools = Boolean(arg.tools && arg.tools.length > 0);
  const postPolicies = applyOpenAIPostParameterBodyPolicies(body, {
    deepSeekThinkingToggle: arg.modelInfo.flags.includes(
      LLMFlags.deepSeekThinkingToggle,
    ),
    deepSeekThinkingType: db.deepseekThinkingType,
    deepSeekReasoningEffort: db.deepseekReasoningEffort,
    toolDefinitions: hasTools
      ? arg.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: simplifySchema(tool.inputSchema),
          },
        }))
      : undefined,
    reverseProxyOobaMode:
      aiModel === "reverse_proxy" && db.reverseProxyOobaMode,
    reverseProxyOobaArgs: db.reverseProxyOobaArgs,
    removeLogitBiasForInlay:
      supportsInlayImage() &&
      !(
        aiModel.startsWith("gpt") ||
        (aiModel === "reverse_proxy" &&
          (db.proxyRequestModel?.startsWith("gpt") ||
            (db.proxyRequestModel === "custom" &&
              db.customProxyRequestModel.startsWith("gpt"))))
      ),
    multiGen: arg.multiGen,
    hasTools,
    genTime: db.genTime,
  });
  body = postPolicies.body;
  if (postPolicies.error) {
    return { type: "fail", result: postPolicies.error };
  }

  const endpoint = resolveOpenAIRequestEndpoint({
    aiModel,
    customURL: arg.customURL,
    modelEndpoint: arg.modelInfo?.endpoint,
    nanoGPTUseSubscriptionEndpoint: db.nanogptUseSubscriptionEndpoint,
    autofillRequestUrl: db.autofillRequestUrl,
  });
  const replacerURL = endpoint.url;
  const risuIdentify = endpoint.risuIdentify;

  if (
    db.openAIFlexProcessing &&
    shouldUseOpenAIFlexProcessing({
      aiModel,
      url: replacerURL,
      isOpenAIProvider: arg.modelInfo.provider === LLMProvider.OpenAI,
    })
  ) {
    body.service_tier = "flex";
  }

  let headers = buildOpenAIRequestHeaders({
    aiModel,
    key: arg.key,
    openAIKey: db.openAIKey,
    nanoGPTKey: db.nanogptKey,
    proxyKey: db.proxyKey,
    openRouterKey: db.openrouterKey,
    keyIdentifier: arg.modelInfo?.keyIdentifier,
    keyByIdentifier: db.OaiCompAPIKeys,
    nanoGPTProvider: db.nanogptProvider,
    risuIdentify,
  });
  body = applyAdditionalParameters(
    body,
    headers,
    getAdditionalParameters(aiModel),
  );

  // Some aux flows are intentionally non-streaming (e.g. memory/translate).
  // If custom Additional Parameters contains stream=true, force non-stream mode back.
  if (!arg.useStreaming) {
    body.stream = false;
  }

  const localNetworkOptions = getLocalNetworkRequestOptions(
    replacerURL,
    db,
    false,
  );
  const streamingLocalNetworkOptions = getLocalNetworkRequestOptions(
    replacerURL,
    db,
    true,
  );

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
      result: JSON.stringify({
        url: replacerURL,
        body: body,
        headers: headers,
      }),
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
