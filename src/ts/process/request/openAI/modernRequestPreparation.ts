import {
  applyOpenAIPostParameterBodyPolicies,
  applyOpenAIPreParameterBodyPolicies,
  buildOpenAIRequestHeaders,
  resolveOpenAIRequestEndpoint,
  resolveOpenAIRequestModel,
  shouldUseOpenAIFlexProcessing,
} from "@risuai/chat-core/openAIProvider.cjs";
import { getDatabase } from "src/ts/storage/database.svelte";
import { LLMFlags, LLMProvider } from "src/ts/model/modellist";
import { getFreeOpenRouterModels } from "src/ts/model/openrouter";
import { simplifySchema } from "src/ts/util";
import { supportsInlayImage } from "../../files/inlays";
import { applyChatTemplate } from "../../templates/chatTemplate";
import { getOpenAIJSONSchema } from "../../templates/jsonSchema";
import type { RequestDataArgumentExtended } from "../request";
import {
  applyAdditionalParameters,
  applyParameters,
  getAdditionalParameters,
} from "../shared";
import { getLocalNetworkRequestOptions } from "./shared";
import type { OpenAIChatExtra } from "./types";
import type { LocalNetworkRequestOptions } from "./shared";

type PreparedOpenAIRequest = {
  ok: true;
  body: Record<string, any>;
  headers: Record<string, string>;
  replacerURL: string;
  localNetworkOptions: LocalNetworkRequestOptions;
  streamingLocalNetworkOptions: LocalNetworkRequestOptions;
};

type FailedOpenAIRequestPreparation = {
  ok: false;
  error: string;
};

export type OpenAIRequestPreparationResult =
  | PreparedOpenAIRequest
  | FailedOpenAIRequestPreparation;

export async function prepareModernOpenAIRequest(
  arg: RequestDataArgumentExtended,
  formatedChat: OpenAIChatExtra[],
): Promise<OpenAIRequestPreparationResult> {
  const db = getDatabase();
  const aiModel = arg.aiModel;
  let openRouterRequestModel = db.openrouterRequestModel;
  if (aiModel === "openrouter" && db.openrouterRequestModel === "risu/free") {
    openRouterRequestModel = await getFreeOpenRouterModels();
  }

  db.cipherChat = false;
  let body: Record<string, any> = {
    model: resolveOpenAIRequestModel({
      aiModel,
      requestModel:
        aiModel === "reverse_proxy" ? db.customProxyRequestModel : aiModel,
      openRouterRequestModel,
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
        ? applyChatTemplate(arg.formated)
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
    return { ok: false, error: postPolicies.error };
  }

  const endpoint = resolveOpenAIRequestEndpoint({
    aiModel,
    customURL: arg.customURL,
    modelEndpoint: arg.modelInfo?.endpoint,
    nanoGPTUseSubscriptionEndpoint: db.nanogptUseSubscriptionEndpoint,
    autofillRequestUrl: db.autofillRequestUrl,
  });
  const replacerURL = endpoint.url;

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

  const headers = buildOpenAIRequestHeaders({
    aiModel,
    key: arg.key,
    openAIKey: db.openAIKey,
    nanoGPTKey: db.nanogptKey,
    proxyKey: db.proxyKey,
    openRouterKey: db.openrouterKey,
    keyIdentifier: arg.modelInfo?.keyIdentifier,
    keyByIdentifier: db.OaiCompAPIKeys,
    nanoGPTProvider: db.nanogptProvider,
    risuIdentify: endpoint.risuIdentify,
  });

  body = applyAdditionalParameters(
    body,
    headers,
    getAdditionalParameters(aiModel),
  );
  if (!arg.useStreaming) body.stream = false;

  return {
    ok: true,
    body,
    headers,
    replacerURL,
    localNetworkOptions: getLocalNetworkRequestOptions(replacerURL, db, false),
    streamingLocalNetworkOptions: getLocalNetworkRequestOptions(
      replacerURL,
      db,
      true,
    ),
  };
}
