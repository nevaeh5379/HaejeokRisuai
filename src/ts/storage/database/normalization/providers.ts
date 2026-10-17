import { defaultColorScheme } from "../../../gui/colorSchemeDefaults";
import { fallback, object, picklist, type InferOutput } from "valibot";
import { LLMFormat } from "../../../model/types";
import type { botPreset, Database } from "../schema";
import {
  oobaDefaults,
  ainDefaults,
  naiDefaults,
  promptSettingsDefaults,
} from "../../presets/presetSchema";
import { normalizePromptTemplate } from "../../presets/promptTemplateNormalization";
import {
  defaultBoolean,
  defaultLooseObject,
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
  hypaModel: fallback(
    picklist([
      "custom",
      "ada",
      "openai3small",
      "openai3large",
      "voyageContext3",
    ]),
    "openai3small",
  ),
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

const colorSchemeDefaults = {
  bgcolor: defaultString(defaultColorScheme.bgcolor),
  darkbg: defaultString(defaultColorScheme.darkbg),
  borderc: defaultString(defaultColorScheme.borderc),
  selected: defaultString(defaultColorScheme.selected),
  draculared: defaultString(defaultColorScheme.draculared),
  textcolor: defaultString(defaultColorScheme.textcolor),
  textcolor2: defaultString(defaultColorScheme.textcolor2),
  darkBorderc: defaultString(defaultColorScheme.darkBorderc),
  darkbutton: defaultString(defaultColorScheme.darkbutton),
  type: fallback(picklist(["light", "dark"]), defaultColorScheme.type),
};

const providerNestedDefaults = {
  ooba: defaultLooseObject(oobaDefaults),
  ainconfig: defaultLooseObject(ainDefaults),
  NAISettings: defaultLooseObject(naiDefaults),
  colorScheme: defaultLooseObject(colorSchemeDefaults),
  deeplOptions: defaultLooseObject(deeplOptionsDefaults),
  deeplXOptions: defaultLooseObject(deeplXOptionsDefaults),
  google: defaultLooseObject(googleDefaults),
  promptSettings: defaultLooseObject(promptSettingsDefaults),
  openrouterProvider: defaultLooseObject(openRouterProviderDefaults),
};

const providerDefaultsSchema = object({
  ...providerScalarDefaults,
  ...localNetworkDefaults,
  ...providerNestedDefaults,
  customColorScheme: defaultLooseObject(colorSchemeDefaults),
});

export type ProviderValidatedDefaults = InferOutput<
  typeof providerDefaultsSchema
>;

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
  const migratedProvider = migrateOpenRouterProvider(data.openrouterProvider);
  Object.assign(data, parseDefaults(providerScalarDefaults, data));
  Object.assign(
    data,
    parseDefaults(providerNestedDefaults, {
      ...data,
      openrouterProvider: migratedProvider,
    }),
  );
  data.customColorScheme = mergeDefaults(
    colorSchemeDefaults,
    data.customColorScheme ??
      (data.colorSchemeName === "custom"
        ? data.colorScheme
        : defaultColorScheme),
  );
  data.openrouterSubRequestModel ??= data.openrouterRequestModel;
  data.nanogptSubRequestModel ??= data.nanogptRequestModel;
  data.nanogptSubRequestModelName ??= data.nanogptRequestModelName;
  data.nanogptSubProvider ??= data.nanogptProvider;
  data.nanogptSubUseSubscriptionEndpoint ??=
    data.nanogptUseSubscriptionEndpoint;
  data.customProxySubRequestModel ??= data.customProxyRequestModel;
  normalizeLocalNetworkSettings(data);
  data.regex ??= [];
  data.reverseProxyOobaArgs ??= {
    mode: "instruct",
  };
  data.additionalParams ??= [];
  normalizeOllamaSettings(data);
}
