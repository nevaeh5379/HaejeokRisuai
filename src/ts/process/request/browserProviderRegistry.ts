import { language } from "../../../lang";
import { requestClaude } from "./anthropic";
import { BrowserProviderExecutor } from "./browserProviderExecutor";
import { requestPlugin, requestWebLLM } from "./browserRuntimeProviders";
import { requestCohere } from "./cohere";
import { requestEcho } from "./echo";
import { requestGoogleCloudVertex } from "./google";
import { requestHorde } from "./horde";
import {
  requestKobold,
  requestOoba,
  requestOobaLegacy,
} from "./localEndpointProviders";
import { requestNovelAI } from "./novelAI";
import { requestNovelList } from "./novelList";
import { requestOllama } from "./ollama";
import {
  requestOpenAI,
  requestOpenAILegacyInstruct,
  requestOpenAIResponseAPI,
} from "./openAI/requests";
import type {
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

export function executeBrowserProvider(
  format: number,
  request: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  return browserProviderExecutor.execute(format, request);
}
