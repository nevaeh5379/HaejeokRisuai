import { prebuiltNAIpresets } from "../../process/templates/templates";
import { defaultColorScheme } from "../../gui/colorscheme";
import { safeStructuredClone } from "../../polyfill";
import { LLMFormat } from "../../model/types";
import type { botPreset, Database } from "../schema";
import { defaultAIN, defaultOoba } from "../presetDefaults";
import { normalizePromptTemplate } from "../presetService";
import {
  defaultBoolean,
  defaultNumber,
  defaultPicklist,
  defaultString,
  defaultStringArray,
  mergeDefaults,
  parseDefaults,
} from "./valibotDefaults";


const providerScalarDefaults = {
  classicMaxWidth: defaultBoolean(false),
  openrouterKey: defaultString(),
  openrouterRequestModel: defaultString("openai/gpt-3.5-turbo"),
  nanogptKey: defaultString(),
  nanogptRequestModel: defaultString(),
  nanogptRequestModelName: defaultString(),
  nanogptProvider: defaultString(),
  nanogptSubscriptionState: defaultString(),
  nanogptUseSubscriptionEndpoint: defaultBoolean(false),
  assetWidth: defaultNumber(-1),
  chatLimitSize: defaultNumber(-1),
  animationSpeed: defaultNumber(0.4),
  colorSchemeName: defaultString("default"),
  hypaModel: defaultString("openai3small"),
  mancerHeader: defaultString(),
  emotionProcesser: defaultPicklist(["submodel", "embedding"], "submodel"),
  translatorType: defaultPicklist(
    ["google", "deepl", "none", "llm", "deeplX", "bergamot"],
    "google",
  ),
  htmlTranslation: defaultBoolean(false),
  NAIadventure: defaultBoolean(false),
  NAIappendName: defaultBoolean(true),
  autofillRequestUrl: defaultBoolean(true),
  customProxyRequestModel: defaultString(),
  generationSeed: defaultNumber(-1),
  newOAIHandle: defaultBoolean(true),
  gptVisionQuality: defaultString("low"),
  huggingfaceKey: defaultString(),
  fishSpeechKey: defaultString(),
  top_p: defaultNumber(1),
  genTime: defaultNumber(1),
  keiServerURL: defaultString(),
  top_k: defaultNumber(0),
  openrouterFallback: defaultBoolean(true),
  openrouterMiddleOut: defaultBoolean(false),
  removePunctuationHypa: defaultBoolean(true),
  memoryLimitThickness: defaultNumber(1),
  heightMode: defaultString("normal"),
  antiClaudeOverload: defaultBoolean(false),
  maxSupaChunkSize: defaultNumber(1200),
  ollamaURL: defaultString(),
  ollamaModel: defaultString(),
  ollamaInputMode: defaultPicklist(["list", "manual"], "manual"),
  ollamaApiKey: defaultString(),
  ollamaModelName: defaultString(),
  ollamaCloudModel: defaultString(),
  ollamaCloudModelName: defaultString(),
  ollamaThinkingMode: defaultPicklist(
    ["auto", "off", "on", "low", "medium", "high"],
    "auto",
  ),
  autoContinueChat: defaultBoolean(false),
  autoContinueMinTokens: defaultNumber(0),
  repetition_penalty: defaultNumber(1),
  min_p: defaultNumber(0),
  top_a: defaultNumber(0),
  customTokenizer: defaultString("tik"),
  instructChatTemplate: defaultString("chatml"),
};

const localNetworkDefaults = {
  localNetworkMode: defaultBoolean(false),
  localNetworkTimeoutSec: defaultNumber(600),
};

const openRouterProviderDefaults = {
  order: defaultStringArray(),
  only: defaultStringArray(),
  ignore: defaultStringArray(),
};

const deeplOptionsDefaults = {
  key: defaultString(),
  freeApi: defaultBoolean(false),
};

const deeplXOptionsDefaults = {
  url: defaultString(),
  token: defaultString(),
};

const googleDefaults = {
  accessToken: defaultString(),
  projectId: defaultString(),
};

const promptSettingsDefaults = {
  assistantPrefill: defaultString(),
  postEndInnerFormat: defaultString(),
  sendChatAsSystem: defaultBoolean(false),
  sendName: defaultBoolean(false),
  utilOverride: defaultBoolean(false),
  customChainOfThought: defaultBoolean(false),
  maxThoughtTagDepth: defaultNumber(-1),
};

export type ProviderValidatedDefaults = Required<
  Pick<
    Database,
    | keyof typeof providerScalarDefaults
    | "localNetworkMode"
    | "localNetworkTimeoutSec"
    | "deeplOptions"
    | "deeplXOptions"
    | "google"
    | "promptSettings"
    | "openrouterProvider"
  >
>;

const supportedHypaModels = new Set([
  "custom",
  "ada",
  "openai3small",
  "openai3large",
  "voyageContext3",
]);

type LocalNetworkSettings = Pick<
  botPreset,
  "localNetworkMode" | "localNetworkTimeoutSec"
>;

function normalizeLocalNetworkSettings(settings: LocalNetworkSettings): void {
  Object.assign(settings, parseDefaults(localNetworkDefaults, settings));
}

function migrateOpenRouterProvider(
  value: unknown,
): Database["openrouterProvider"] | undefined {
  if (typeof value === "string") {
    return {
      order: value ? [value] : [],
      only: [],
      ignore: [],
    };
  }
  return value as Database["openrouterProvider"] | undefined;
}

export function normalizePortablePreset(preset: botPreset): void {
  if (Array.isArray(preset.promptTemplate)) {
    preset.promptTemplate = normalizePromptTemplate(preset.promptTemplate);
  }
  normalizeLocalNetworkSettings(preset);
  const migratedProvider = migrateOpenRouterProvider(preset.openrouterProvider);
  if (migratedProvider) {
    preset.openrouterProvider = parseDefaults(
      openRouterProviderDefaults,
      migratedProvider,
    );
  }
}

function normalizeOllamaSettings(data: Database): void {
  data.ollamaModelSource ??=
    data.aiModel === "ollama-cloud" || data.subModel === "ollama-cloud"
      ? "cloud"
      : "local";
  data.ollamaRequestFormat ??= LLMFormat.Ollama;

  if (
    (data.aiModel === "ollama-cloud" || data.subModel === "ollama-cloud") &&
    !data.ollamaCloudModel
  ) {
    data.ollamaCloudModel = data.ollamaModel;
    data.ollamaCloudModelName = data.ollamaModelName;
  }

  data.ollamaSubModel ??= data.ollamaModel;
  data.ollamaSubModelName ??= data.ollamaModelName;
  data.ollamaCloudSubModel ??= data.ollamaCloudModel;
  data.ollamaCloudSubModelName ??= data.ollamaCloudModelName;
}

export function normalizeProviderDatabaseSettings(data: Database): void {
  Object.assign(data, parseDefaults(providerScalarDefaults, data));
  data.ooba ??= safeStructuredClone(defaultOoba);
  data.ainconfig ??= safeStructuredClone(defaultAIN);
  data.openrouterSubRequestModel ??= data.openrouterRequestModel;
  data.nanogptSubRequestModel ??= data.nanogptRequestModel;
  data.nanogptSubRequestModelName ??= data.nanogptRequestModelName;
  data.nanogptSubProvider ??= data.nanogptProvider;
  data.nanogptSubUseSubscriptionEndpoint ??=
    data.nanogptUseSubscriptionEndpoint;
  data.NAIsettings ??= safeStructuredClone(prebuiltNAIpresets);
  data.colorScheme ??= safeStructuredClone(defaultColorScheme);
  data.customColorScheme ??= safeStructuredClone(
    data.colorSchemeName === "custom" ? data.colorScheme : defaultColorScheme,
  );
  data.NAIsettings.starter ??= "";
  if (!supportedHypaModels.has(data.hypaModel as string)) {
    data.hypaModel = "openai3small";
  }
  data.deeplOptions = mergeDefaults(deeplOptionsDefaults, data.deeplOptions);
  data.deeplXOptions = mergeDefaults(deeplXOptionsDefaults, data.deeplXOptions);
  data.NAIsettings.cfg_scale ??= 1;
  data.NAIsettings.mirostat_tau ??= 0;
  data.NAIsettings.mirostat_lr ??= 1;
  data.customProxySubRequestModel ??= data.customProxyRequestModel;
  normalizeLocalNetworkSettings(data);
  data.presetRegex ??= [];
  data.reverseProxyOobaArgs ??= {
    mode: "instruct",
  };
  data.google = mergeDefaults(googleDefaults, data.google);
  data.promptSettings = mergeDefaults(
    promptSettingsDefaults,
    data.promptSettings,
  );
  data.additionalParams ??= [];
  normalizeOllamaSettings(data);
  const migratedProvider = migrateOpenRouterProvider(data.openrouterProvider);
  if (migratedProvider) {
    data.openrouterProvider = migratedProvider;
  }
  data.openrouterProvider = parseDefaults(
    openRouterProviderDefaults,
    data.openrouterProvider ?? {},
  );
}
