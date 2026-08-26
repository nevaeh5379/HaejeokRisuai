import { language } from "../../../lang";
import { getModelInfo } from "../../model/modellist";
import { getDatabase } from "../../storage/database.svelte";
import { formatProviderMessages } from "@risuai/chat-core/providerPrompt.cjs";
import { prepareProviderExecutionContext } from "@risuai/chat-core/providerContext.cjs";
import { requestClaude } from "./anthropic";
import { requestGoogleCloudVertex } from "./google";
import { requestHorde } from "./horde";
import { requestEcho } from "./echo";
import { requestOllama } from "./ollama";
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
import {
  requestOpenAI,
  requestOpenAILegacyInstruct,
  requestOpenAIResponseAPI,
} from "./openAI/requests";
import type { ModelModeExtended } from "./shared";

export type {
  ToolCall,
  requestDataArgument,
  RequestDataArgumentExtended,
  requestDataResponse,
  StreamResponseChunk,
} from "./requestContracts";
import type {
  requestDataArgument,
  RequestDataArgumentExtended,
  requestDataResponse,
} from "./requestContracts";

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
