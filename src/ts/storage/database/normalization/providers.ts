import { prebuiltNAIpresets } from "../../../process/templates/templates";
import { defaultColorScheme } from "../../../gui/colorSchemeDefaults";
import { fallback, object, picklist, type InferOutput } from "valibot";
import { LLMFormat } from "../../../model/types";
import type { botPreset, Database } from "../schema";
import { defaultAIN, defaultOoba } from "../../presets/presetDefaults";
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

const promptSettingsDefaults = {
  assistantPrefill: defaultString(),
  postEndInnerFormat: defaultString(),
  sendChatAsSystem: defaultBoolean(false),
  sendName: defaultBoolean(false),
  utilOverride: defaultBoolean(false),
  customChainOfThought: defaultBoolean(false),
  maxThoughtTagDepth: defaultNumber(-1),
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

const oobaDefaults = {
  max_new_tokens: defaultNumber(defaultOoba.max_new_tokens),
  do_sample: defaultBoolean(defaultOoba.do_sample),
  temperature: defaultNumber(defaultOoba.temperature),
  top_p: defaultNumber(defaultOoba.top_p),
  typical_p: defaultNumber(defaultOoba.typical_p),
  repetition_penalty: defaultNumber(defaultOoba.repetition_penalty),
  encoder_repetition_penalty: defaultNumber(
    defaultOoba.encoder_repetition_penalty,
  ),
  top_k: defaultNumber(defaultOoba.top_k),
  min_length: defaultNumber(defaultOoba.min_length),
  no_repeat_ngram_size: defaultNumber(defaultOoba.no_repeat_ngram_size),
  num_beams: defaultNumber(defaultOoba.num_beams),
  penalty_alpha: defaultNumber(defaultOoba.penalty_alpha),
  length_penalty: defaultNumber(defaultOoba.length_penalty),
  early_stopping: defaultBoolean(defaultOoba.early_stopping),
  seed: defaultNumber(defaultOoba.seed),
  add_bos_token: defaultBoolean(defaultOoba.add_bos_token),
  truncation_length: defaultNumber(defaultOoba.truncation_length),
  ban_eos_token: defaultBoolean(defaultOoba.ban_eos_token),
  skip_special_tokens: defaultBoolean(defaultOoba.skip_special_tokens),
  top_a: defaultNumber(defaultOoba.top_a),
  tfs: defaultNumber(defaultOoba.tfs),
  epsilon_cutoff: defaultNumber(defaultOoba.epsilon_cutoff),
  eta_cutoff: defaultNumber(defaultOoba.eta_cutoff),
  formating: defaultLooseObject({
    header: defaultString(defaultOoba.formating.header),
    systemPrefix: defaultString(defaultOoba.formating.systemPrefix),
    userPrefix: defaultString(defaultOoba.formating.userPrefix),
    assistantPrefix: defaultString(defaultOoba.formating.assistantPrefix),
    seperator: defaultString(defaultOoba.formating.seperator),
    useName: defaultBoolean(defaultOoba.formating.useName),
  }),
};

const ainDefaults = {
  top_p: defaultNumber(defaultAIN.top_p),
  rep_pen: defaultNumber(defaultAIN.rep_pen),
  top_a: defaultNumber(defaultAIN.top_a),
  rep_pen_slope: defaultNumber(defaultAIN.rep_pen_slope),
  rep_pen_range: defaultNumber(defaultAIN.rep_pen_range),
  typical_p: defaultNumber(defaultAIN.typical_p),
  badwords: defaultString(defaultAIN.badwords),
  stoptokens: defaultString(defaultAIN.stoptokens),
  top_k: defaultNumber(defaultAIN.top_k),
};

const naiDefaults = {
  topK: defaultNumber(prebuiltNAIpresets.topK),
  topP: defaultNumber(prebuiltNAIpresets.topP),
  topA: defaultNumber(prebuiltNAIpresets.topA),
  tailFreeSampling: defaultNumber(prebuiltNAIpresets.tailFreeSampling),
  repetitionPenalty: defaultNumber(prebuiltNAIpresets.repetitionPenalty),
  repetitionPenaltyRange: defaultNumber(
    prebuiltNAIpresets.repetitionPenaltyRange,
  ),
  repetitionPenaltySlope: defaultNumber(
    prebuiltNAIpresets.repetitionPenaltySlope,
  ),
  repostitionPenaltyPresence: defaultNumber(
    prebuiltNAIpresets.repostitionPenaltyPresence,
  ),
  seperator: defaultString(prebuiltNAIpresets.seperator),
  frequencyPenalty: defaultNumber(prebuiltNAIpresets.frequencyPenalty),
  presencePenalty: defaultNumber(prebuiltNAIpresets.presencePenalty),
  typicalp: defaultNumber(prebuiltNAIpresets.typicalp),
  starter: defaultString(prebuiltNAIpresets.starter),
  cfg_scale: defaultNumber(1),
  mirostat_tau: defaultNumber(0),
  mirostat_lr: defaultNumber(1),
};

const providerNestedDefaults = {
  ooba: defaultLooseObject(oobaDefaults),
  ainconfig: defaultLooseObject(ainDefaults),
  NAIsettings: defaultLooseObject(naiDefaults),
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
  data.presetRegex ??= [];
  data.reverseProxyOobaArgs ??= {
    mode: "instruct",
  };
  data.additionalParams ??= [];
  normalizeOllamaSettings(data);
}
