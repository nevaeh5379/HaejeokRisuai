import { createHypaV3Preset } from "../../../process/memory/hypav3Preset";
import { normalizeTranslatorPresetState } from "../../../translator/presets";
import { safeStructuredClone } from "../../../polyfill";
import { defaultHotkeys } from "../../../defaulthotkeys";
import { LLMFormat } from "../../../model/types";
import type { Database } from "../schema";
import {
  defaultBoolean,
  defaultLooseObject,
  defaultNumber,
  defaultPicklist,
  defaultString,
  defaultStringArray,
  mergeDefaults,
  optionalBoolean,
  optionalString,
  parseDefaults,
} from "./valibotDefaults";

const llmFormatOptions = Object.values(LLMFormat) as [
  LLMFormat,
  ...LLMFormat[],
];

const featureScalarDefaults = {
  useInstructPrompt: defaultBoolean(false),
  hanuraiEnable: defaultBoolean(false),
  hanuraiSplit: defaultBoolean(false),
  hanuraiTokens: defaultNumber(1000),
  textAreaSize: defaultNumber(0),
  sideBarSize: defaultNumber(0),
  textAreaTextSize: defaultNumber(0),
  combineTranslation: defaultBoolean(false),
  customPromptTemplateToggle: defaultString(),
  templateDefaultVariables: defaultString(),
  hypaAllocatedTokens: defaultNumber(3000),
  hypaChunkSize: defaultNumber(3000),
  dallEQuality: defaultString("standard"),
  font: defaultString("default"),
  customFont: defaultString(),
  lineHeight: defaultNumber(1.25),
  stabilityModel: defaultString("sd3-large"),
  stabllityStyle: defaultString(),
  legacyTranslation: defaultBoolean(false),
  comfyUiUrl: defaultString("http://localhost:8188"),
  hideApiKey: defaultBoolean(true),
  unformatQuotes: defaultBoolean(false),
  ttsAutoSpeech: defaultBoolean(false),
  autoColorAdapt: defaultBoolean(false),
  colorAdaptEngine: defaultPicklist(
    ["oklch", "colord", "leonardo", "darkreader"],
    "oklch",
  ),
  translatorInputLanguage: defaultString("auto"),
  falModel: defaultString("fal-ai/flux/dev"),
  falLoraScale: defaultNumber(1),
  customCSS: defaultString(),
  strictJsonSchema: defaultBoolean(true),
  customQuotes: defaultBoolean(false),
  groupOtherBotRole: defaultString("user"),
  customGUI: defaultString(),
  systemContentReplacement: defaultString("system: {{slot}}"),
  systemRoleReplacement: defaultPicklist(["user", "assistant"], "user"),
  vertexAccessToken: defaultString(),
  vertexAccessTokenExpires: defaultNumber(0),
  vertexClientEmail: defaultString(),
  vertexPrivateKey: defaultString(),
  vertexRegion: defaultString("global"),
  seperateParametersEnabled: defaultBoolean(false),
  enableCustomFlags: defaultBoolean(false),
  assetMaxDifference: defaultNumber(4),
  showSavingIcon: defaultBoolean(false),
  showPromptComparison: defaultBoolean(false),
  reasoningEffort: defaultNumber(0),
  verbosity: defaultNumber(1),
  hypaV3PresetId: defaultNumber(0),
  showDeprecatedTriggerV2: defaultBoolean(false),
  returnCSSError: defaultBoolean(true),
  realmDirectOpen: defaultBoolean(false),
  checkCorruption: defaultBoolean(false),
  toggleConfirmRecommendedPreset: defaultBoolean(false),
  useExperimentalGoogleTranslator: defaultBoolean(false),
  thinkingType: defaultPicklist(["off", "budget", "adaptive"], "budget"),
  deepseekThinkingType: defaultPicklist(["off", "enabled"], "off"),
  adaptiveThinkingEffort: defaultPicklist(
    ["low", "medium", "high", "xhigh", "max"],
    "high",
  ),
  deepseekReasoningEffort: defaultPicklist(["high", "max"], "high"),
  customAPIFormat: defaultPicklist(
    llmFormatOptions,
    LLMFormat.OpenAICompatible,
  ),
  doNotChangeSeperateModels: defaultBoolean(false),
  seperateModelsForAxModels: defaultBoolean(false),
  enableScrollToActiveChar: defaultBoolean(true),
};

const hypaCustomSettingsDefaults = {
  url: defaultString(),
  key: defaultString(),
  model: defaultString(),
};

const separateModelDefaults = {
  memory: defaultString(),
  emotion: defaultString(),
  translate: defaultString(),
  otherAx: defaultString(),
};

const providerModelOverrideDefaults = {
  ollamaModel: optionalString(),
  ollamaModelName: optionalString(),
  ollamaCloudModel: optionalString(),
  ollamaCloudModelName: optionalString(),
  openrouterRequestModel: optionalString(),
  customProxyRequestModel: optionalString(),
  nanogptRequestModel: optionalString(),
  nanogptRequestModelName: optionalString(),
  nanogptProvider: optionalString(),
  nanogptUseSubscriptionEndpoint: optionalBoolean(),
};

const providerModelOverridesDefaults = {
  memory: defaultLooseObject(providerModelOverrideDefaults),
  emotion: defaultLooseObject(providerModelOverrideDefaults),
  translate: defaultLooseObject(providerModelOverrideDefaults),
  otherAx: defaultLooseObject(providerModelOverrideDefaults),
};

const fallbackModelDefaults = {
  model: defaultStringArray(),
  memory: defaultStringArray(),
  emotion: defaultStringArray(),
  translate: defaultStringArray(),
  otherAx: defaultStringArray(),
};

const comfyConfigDefaults = {
  workflow: defaultString(),
  posNodeID: defaultString(),
  posInputName: defaultString("text"),
  negNodeID: defaultString(),
  negInputName: defaultString("text"),
  timeout: defaultNumber(30),
};

const staticsDefaults = {
  messages: defaultNumber(0),
  imports: defaultNumber(0),
};

export type FeatureValidatedDefaults = Required<
  Pick<
    Database,
    | keyof typeof featureScalarDefaults
    | "hypaCustomSettings"
    | "seperateModels"
    | "fallbackModels"
    | "comfyConfig"
    | "statics"
    | "providerModelOverrides"
  >
>;

function normalizeHypaV3Presets(data: Database): void {
  data.hypaV3Presets ??= [
    createHypaV3Preset("Default", {
      summarizationPrompt: data.supaMemoryPrompt || "",
      ...data.hypaV3Settings,
    }),
  ];
  if (data.hypaV3Presets.length > 0) {
    data.hypaV3Presets = data.hypaV3Presets.map((preset, i) =>
      createHypaV3Preset(
        preset.name || `Preset ${i + 1}`,
        preset.settings || {},
      ),
    );
  }
}

function migrateAntiClaudeOverload(data: Database): void {
  if (!data.antiClaudeOverload) return;
  data.antiClaudeOverload = false;
  data.antiServerOverloads = true;
}

function normalizeHypaCustomSettings(data: Database): void {
  data.hypaCustomSettings = mergeDefaults(
    hypaCustomSettingsDefaults,
    data.hypaCustomSettings,
  );
}

function normalizeSeparateModels(data: Database): void {
  data.seperateModels = mergeDefaults(
    separateModelDefaults,
    data.seperateModels,
  );
}

function normalizeProviderModelOverrides(data: Database): void {
  data.providerModelOverrides = mergeDefaults(
    providerModelOverridesDefaults,
    data.providerModelOverrides,
  );
}

function normalizeHotkeys(data: Database): void {
  if (!data.hotkeys) {
    data.hotkeys = safeStructuredClone(defaultHotkeys);
  } else {
    const existingActions = new Set(data.hotkeys.map((hotkey) => hotkey.action));
    const newHotkeys = defaultHotkeys.filter(
      (hotkey) => !existingActions.has(hotkey.action),
    );
    if (newHotkeys.length > 0) {
      data.hotkeys.push(...safeStructuredClone(newHotkeys));
    }
  }

  if (data.enableScrollToActiveChar === false) {
    data.hotkeys = data.hotkeys.filter(
      (hotkey) => hotkey.action !== "scrollToActiveChar",
    );
  }
}

function normalizeFallbackModels(data: Database): void {
  data.fallbackModels = mergeDefaults(
    fallbackModelDefaults,
    data.fallbackModels,
  );
  for (const key of Object.keys(fallbackModelDefaults) as Array<
    keyof Database["fallbackModels"]
  >) {
    data.fallbackModels[key] = data.fallbackModels[key].filter(Boolean);
  }
}

export function normalizeFeatureDatabaseSettings(data: Database): void {
  Object.assign(data, parseDefaults(featureScalarDefaults, data));
  data.globalChatVariables ??= {};
  data.comfyConfig = mergeDefaults(comfyConfigDefaults, data.comfyConfig);
  data.statics = mergeDefaults(staticsDefaults, data.statics);
  data.customQuotesData ??= ["“", "”", "‘", "’"];
  data.seperateParameters ??= {
    memory: {},
    emotion: {},
    translate: {},
    otherAx: {},
    overrides: {},
  };
  data.seperateParameters.memory ??= {};
  data.seperateParameters.emotion ??= {};
  data.seperateParameters.translate ??= {};
  data.seperateParameters.otherAx ??= {};
  data.seperateParameters.overrides ??= {};
  data.customFlags ??= [];
  data.banCharacterset ??= [];
  data.OaiCompAPIKeys ??= {};
  normalizeHypaV3Presets(data);
  normalizeTranslatorPresetState(data);
  migrateAntiClaudeOverload(data);
  normalizeHypaCustomSettings(data);
  normalizeSeparateModels(data);
  normalizeProviderModelOverrides(data);
  data.modelTools ??= [];
  normalizeHotkeys(data);
  normalizeFallbackModels(data);
}
