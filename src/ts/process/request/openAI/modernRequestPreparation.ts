import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import {
  applyOpenAIPostParameterBodyPolicies,
  applyOpenAIPreParameterBodyPolicies,
  buildOpenAIRequestHeaders,
  resolveOpenAIRequestEndpoint,
  resolveOpenAIRequestModel,
  shouldUseOpenAIFlexProcessing,
} from "@risuai/chat-core/openAIProvider.cjs";

import { LLMFlags, LLMProvider } from "src/ts/model/modellist";
import { getFreeOpenRouterModels } from "src/ts/model/openrouter";
import { simplifySchema } from "src/ts/util";
import { supportsInlayImage } from "../../files/inlays";
import { applyChatTemplate } from "../../templates/chatTemplate";
import { getOpenAIJSONSchema } from "../../templates/jsonSchema";
import {
  resolveRequestCharacter,
  resolveRequestParserContext,
} from "../requestContext";
import type { RequestDataArgumentExtended } from "../requestContracts";
import {
  getProviderModeOverride,
  resolveProviderRoleModel,
  resolveProviderRoleModelForMode,
  resolveProviderRoleSetting,
  resolveProviderRoleSettingForMode,
} from "../providerRoleSettings";
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
  const db = settingsStore.state;
  const aiModel = arg.aiModel;
  const modeOverride = getProviderModeOverride(
    presetStore.state.seperateModelsForAxModels,
    presetStore.state.providerModelOverrides,
    arg.mode,
  );

  let openRouterRequestModel = resolveProviderRoleModelForMode(
    presetStore.state.openrouterRequestModel,
    presetStore.state.openrouterSubRequestModel,
    arg.mode,
    modeOverride?.openrouterRequestModel,
  );
  const nanoGPTRequestModel = resolveProviderRoleModelForMode(
    db.nanogptRequestModel,
    db.nanogptSubRequestModel,
    arg.mode,
    modeOverride?.nanogptRequestModel,
  );
  const nanoGPTUseSubscriptionEndpoint = resolveProviderRoleSettingForMode(
    db.nanogptUseSubscriptionEndpoint,
    db.nanogptSubUseSubscriptionEndpoint,
    arg.mode,
    modeOverride?.nanogptUseSubscriptionEndpoint,
  );
  const nanoGPTProvider = resolveProviderRoleSettingForMode(
    db.nanogptProvider,
    db.nanogptSubProvider,
    arg.mode,
    modeOverride?.nanogptProvider,
  );
  if (aiModel === "openrouter" && openRouterRequestModel === "risu/free") {
    openRouterRequestModel = await getFreeOpenRouterModels();
  }

  db.cipherChat = false;
  let body: Record<string, any> = {
    model: resolveOpenAIRequestModel({
      aiModel,
      requestModel:
        aiModel === "reverse_proxy" ? arg.modelInfo.internalID : aiModel,
      openRouterRequestModel,
      nanoGPTRequestModel,
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
      (presetStore.state.jsonSchemaEnabled || arg.schema) &&
      !arg.modelInfo.flags.includes(LLMFlags.noStructuredOutput)
        ? getOpenAIJSONSchema(arg.schema, resolveRequestParserContext(arg))
        : undefined,
    prediction: db.OAIPrediction,
    aiModel,
    openRouterFallback: db.openrouterFallback,
    openRouterMiddleOut: db.openrouterMiddleOut,
    openRouterProvider: presetStore.state.openrouterProvider,
    instructPrompt:
      aiModel === "openrouter" && presetStore.state.useInstructPrompt
        ? applyChatTemplate(arg.formated, {
            currentChar: resolveRequestCharacter(arg),
            chatTarget: arg.triggerTarget,
          })
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
    deepSeekThinkingType: presetStore.state.deepseekThinkingType,
    deepSeekReasoningEffort: presetStore.state.deepseekReasoningEffort,
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
    reverseProxyOobaArgs: presetStore.state.reverseProxyOobaArgs,
    removeLogitBiasForInlay:
      supportsInlayImage() &&
      !(
        aiModel.startsWith("gpt") ||
        (aiModel === "reverse_proxy" &&
          (presetStore.state.proxyRequestModel?.startsWith("gpt") ||
            (presetStore.state.proxyRequestModel === "custom" &&
              (arg.modelInfo.internalID ?? "").startsWith("gpt"))))
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
    nanoGPTUseSubscriptionEndpoint,
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
    proxyKey: presetStore.state.proxyKey,
    openRouterKey: db.openrouterKey,
    keyIdentifier: arg.modelInfo?.keyIdentifier,
    keyByIdentifier: db.OaiCompAPIKeys,
    nanoGPTProvider,
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
    localNetworkOptions: getLocalNetworkRequestOptions(replacerURL),
    streamingLocalNetworkOptions: getLocalNetworkRequestOptions(
      replacerURL,
      undefined,
      true,
    ),
  };
}
