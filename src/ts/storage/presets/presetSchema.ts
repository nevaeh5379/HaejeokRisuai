import * as v from "valibot";
import rfdc from "rfdc";
import type {
  FormatingOrderItem,
  customscript,
  SeparateParameters,
  ProviderModelOverride,
  DynamicOutput,
} from "../database/schema";
import type { OobaChatCompletionRequestParams } from "../../model/ooba";
import type { PromptItem } from "../../process/prompt";
import { LLMFormat, type LLMFlags } from "../../model/types";
import {
  defaultMainPrompt,
  defaultJailbreak,
  defaultAutoSuggestPrompt,
} from "./defaultPrompts";
import { defaultAIN, defaultOoba, defaultNAI } from "./providerDefaults";
import {
  defaultLooseObject,
  defaultString,
  defaultNumber,
  defaultBoolean,
  defaultStringArray,
} from "../database/normalization/valibotDefaults";

const clone = rfdc();
// Legacy transition hints, read only by applyPresetSettings. Valibot parsing
// always uses the declared defaults, independent of the active preset.
const retainedFields = new WeakSet<object>();
function retain<T extends v.GenericSchema>(schema: T): T {
  retainedFields.add(schema);
  return schema;
}
function defaultArray<T>() {
  return v.fallback(v.array(v.custom<T>(() => true)), () => []);
}
function defaultObject<T extends object>(value: T) {
  return v.fallback(
    v.custom<T>(
      (input) => !!input && typeof input === "object" && !Array.isArray(input),
    ),
    () => clone(value),
  );
}
export const promptSettingsDefaults = {
  assistantPrefill: defaultString(),
  postEndInnerFormat: defaultString(),
  sendChatAsSystem: defaultBoolean(false),
  sendName: defaultBoolean(false),
  utilOverride: defaultBoolean(false),
  customChainOfThought: defaultBoolean(false),
  maxThoughtTagDepth: defaultNumber(-1),
};

export const oobaDefaults = {
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

export const ainDefaults = {
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

export const naiDefaults = {
  topK: defaultNumber(defaultNAI.topK),
  topP: defaultNumber(defaultNAI.topP),
  topA: defaultNumber(defaultNAI.topA),
  tailFreeSampling: defaultNumber(defaultNAI.tailFreeSampling),
  repetitionPenalty: defaultNumber(defaultNAI.repetitionPenalty),
  repetitionPenaltyRange: defaultNumber(defaultNAI.repetitionPenaltyRange),
  repetitionPenaltySlope: defaultNumber(defaultNAI.repetitionPenaltySlope),
  repostitionPenaltyPresence: defaultNumber(
    defaultNAI.repostitionPenaltyPresence,
  ),
  seperator: defaultString(defaultNAI.seperator),
  frequencyPenalty: defaultNumber(defaultNAI.frequencyPenalty),
  presencePenalty: defaultNumber(defaultNAI.presencePenalty),
  typicalp: defaultNumber(defaultNAI.typicalp),
  starter: defaultString(defaultNAI.starter),
  cfg_scale: defaultNumber(1),
  mirostat_tau: defaultNumber(0),
  mirostat_lr: defaultNumber(1),
};

const axisModels = { memory: "", emotion: "", translate: "", otherAx: "" };
const separateParameters = {
  memory: {},
  emotion: {},
  translate: {},
  otherAx: {},
  overrides: {},
} as {
  memory: SeparateParameters;
  emotion: SeparateParameters;
  translate: SeparateParameters;
  otherAx: SeparateParameters;
  overrides: Record<string, SeparateParameters>;
};
const providerOverrides = {
  memory: {},
  emotion: {},
  translate: {},
  otherAx: {},
} as Record<keyof typeof axisModels, ProviderModelOverride>;

export const presetSchema = v.object({
  apiType: retain(defaultString("gemini-3-flash-preview")),
  localNetworkMode: retain(defaultBoolean(false)),
  localNetworkTimeoutSec: retain(defaultNumber(600)),
  mainPrompt: retain(defaultString(defaultMainPrompt)),
  jailbreak: retain(defaultString(defaultJailbreak)),
  globalNote: retain(defaultString()),
  temperature: retain(defaultNumber(80)),
  maxContext: retain(defaultNumber(4000)),
  maxResponse: retain(defaultNumber(300)),
  frequencyPenalty: retain(defaultNumber(70)),
  PresensePenalty: retain(defaultNumber(70)),
  formatingOrder: retain(
    v.fallback(
      v.array(v.custom<FormatingOrderItem>(() => true)),
      () =>
        [
          "main",
          "description",
          "personaPrompt",
          "chats",
          "lastChat",
          "jailbreak",
          "lorebook",
          "globalNote",
          "authorNote",
        ] as FormatingOrderItem[],
    ),
  ),
  aiModel: retain(defaultString("gemini-3-flash-preview")),
  subModel: retain(defaultString("gemini-3-flash-preview")),
  currentPluginProvider: retain(defaultString()),
  textgenWebUIStreamURL: retain(defaultString()),
  textgenWebUIBlockingURL: retain(defaultString()),
  forceReplaceUrl: retain(defaultString()),
  promptPreprocess: retain(defaultBoolean(false)),
  bias: retain(defaultArray<[string, number]>()),
  koboldURL: retain(defaultString()),
  proxyKey: retain(defaultString()),
  ooba: retain(defaultLooseObject(oobaDefaults)),
  ainconfig: retain(defaultLooseObject(ainDefaults)),
  openrouterRequestModel: retain(defaultString("openai/gpt-3.5-turbo")),
  openrouterSubRequestModel: retain(defaultString("openai/gpt-3.5-turbo")),
  proxyRequestModel: retain(defaultString()),
  NAISettings: retain(defaultLooseObject(naiDefaults)),
  autoSuggestPrompt: retain(defaultString(defaultAutoSuggestPrompt)),
  autoSuggestPrefix: retain(defaultString()),
  autoSuggestClean: retain(defaultBoolean(true)),
  promptTemplate: v.fallback(
    v.nullable(v.array(v.custom<PromptItem>(() => true))),
    null,
  ),
  NAIadventure: defaultBoolean(false),
  NAIappendName: defaultBoolean(false),
  localStopStrings: v.fallback(v.optional(v.array(v.string())), undefined),
  customProxyRequestModel: defaultString(),
  customProxySubRequestModel: defaultString(),
  reverseProxyOobaArgs: defaultObject<OobaChatCompletionRequestParams>({
    mode: "instruct",
  }),
  top_p: defaultNumber(1),
  promptSettings: defaultLooseObject({
    ...promptSettingsDefaults,
    trimStartNewChat: v.fallback(v.optional(v.boolean()), undefined),
  }),
  repetition_penalty: v.fallback(v.optional(v.number()), undefined),
  min_p: v.fallback(v.optional(v.number()), undefined),
  top_a: v.fallback(v.optional(v.number()), undefined),
  openrouterProvider: v.fallback(
    v.optional(
      v.object({
        order: defaultStringArray(),
        only: defaultStringArray(),
        ignore: defaultStringArray(),
      }),
    ),
    undefined,
  ),
  useInstructPrompt: defaultBoolean(false),
  customPromptTemplateToggle: defaultString(),
  templateDefaultVariables: defaultString(),
  moduleIntergration: defaultString(),
  top_k: retain(defaultNumber(0)),
  instructChatTemplate: retain(defaultString("chatml")),
  JinjaTemplate: retain(defaultString()),
  jsonSchemaEnabled: defaultBoolean(false),
  jsonSchema: defaultString(),
  strictJsonSchema: defaultBoolean(true),
  extractJson: defaultString(),
  groupOtherBotRole: defaultString("user"),
  groupTemplate: defaultString(),
  seperateParametersEnabled: defaultBoolean(false),
  customAPIFormat: v.fallback(
    v.picklist(Object.values(LLMFormat)),
    LLMFormat.OpenAICompatible,
  ),
  systemContentReplacement: defaultString(),
  systemRoleReplacement: v.fallback(v.picklist(["user", "assistant"]), "user"),
  customFlags: defaultArray<LLMFlags>(),
  enableCustomFlags: defaultBoolean(false),
  regex: defaultArray<customscript>(),
  reasonEffort: defaultNumber(0),
  thinkingTokens: v.fallback(v.nullable(v.number()), null),
  thinkingType: v.fallback(v.picklist(["off", "budget", "adaptive"]), "budget"),
  deepseekThinkingType: v.fallback(v.picklist(["off", "enabled"]), "off"),
  adaptiveThinkingEffort: v.fallback(
    v.picklist(["low", "medium", "high", "xhigh", "max"]),
    "high",
  ),
  deepseekReasoningEffort: v.fallback(v.picklist(["high", "max"]), "high"),
  outputImageModal: defaultBoolean(false),
  seperateModelsForAxModels: defaultBoolean(false),
  seperateModels: defaultObject(axisModels),
  providerModelOverrides: defaultObject(providerOverrides),
  fallbackModels: defaultObject({
    memory: [] as string[],
    emotion: [] as string[],
    translate: [] as string[],
    otherAx: [] as string[],
    model: [] as string[],
  }),
  fallbackWhenBlankResponse: defaultBoolean(false),
  seperateParameters: defaultObject(separateParameters),
  modelTools: defaultStringArray(),
  verbosity: defaultNumber(1),
  dynamicOutput: v.fallback(
    v.optional(
      v.custom<DynamicOutput>((input) => !!input && typeof input === "object"),
    ),
    undefined,
  ),
});

export type PresetSettings = v.InferOutput<typeof presetSchema>;
export type PresetSettingKey = keyof PresetSettings;
export const PRESET_SETTING_KEYS = Object.freeze(
  Object.keys(presetSchema.entries) as PresetSettingKey[],
);
export function retainsMissingPresetField(key: PresetSettingKey): boolean {
  return retainedFields.has(presetSchema.entries[key]);
}
export function createPresetSettings(input: unknown = {}): PresetSettings {
  return clone(v.parse(presetSchema, input));
}
