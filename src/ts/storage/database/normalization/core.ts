import { defaultJailbreak, defaultMainPrompt } from "../../presets/defaultPrompts";
import type { Database } from "../schema";
import { normalizePromptTemplate } from "../../presets/presetService";
import {
  defaultBoolean,
  defaultNumber,
  defaultString,
  parseDefaults,
} from "./valibotDefaults";

const coreScalarDefaults = {
  apiType: defaultString("gemini-3-flash-preview"),
  openAIKey: defaultString(),
  mainPrompt: defaultString(defaultMainPrompt),
  jailbreak: defaultString(defaultJailbreak),
  globalNote: defaultString(),
  temperature: defaultNumber(80),
  maxContext: defaultNumber(4000),
  maxResponse: defaultNumber(500),
  frequencyPenalty: defaultNumber(70),
  PresensePenalty: defaultNumber(70),
  aiModel: defaultString("gemini-3-flash-preview"),
  jailbreakToggle: defaultBoolean(false),
  loreBookDepth: defaultNumber(5),
  loreBookToken: defaultNumber(800),
  additionalPrompt: defaultString(
    "The assistant must act as {{char}}. user is {{user}}.",
  ),
  descriptionPrefix: defaultString("description of {{char}}: "),
  forceReplaceUrl: defaultString(),
  language: defaultString("en"),
  swipe: defaultBoolean(true),
  translator: defaultString(),
  translatorMaxResponse: defaultNumber(1000),
  currentPluginProvider: defaultString(),
  zoomsize: defaultNumber(100),
  customBackground: defaultString(),
  textgenWebUIStreamURL: defaultString("wss://localhost/api/"),
  textgenWebUIBlockingURL: defaultString("https://localhost/api/"),
  autoTranslate: defaultBoolean(false),
  fullScreen: defaultBoolean(false),
  playMessage: defaultBoolean(false),
  iconsize: defaultNumber(100),
  theme: defaultString(),
  subModel: defaultString("gemini-3-flash-preview"),
  waifuWidth: defaultNumber(100),
  waifuWidth2: defaultNumber(100),
  emotionPrompt: defaultString(),
  proxyKey: defaultString(),
};

export type CoreValidatedDefaults = Required<
  Pick<Database, keyof typeof coreScalarDefaults>
>;

export function normalizeCoreDatabaseSettings(data: Database): void {
  Object.assign(data, parseDefaults(coreScalarDefaults, data));
  data.formatingOrder ??= [
    "main",
    "description",
    "personaPrompt",
    "chats",
    "lastChat",
    "jailbreak",
    "lorebook",
    "globalNote",
    "authorNote",
  ];
  data.plugins ??= [];
  data.pluginCustomStorage ??= {};
  if (Array.isArray(data.promptTemplate)) {
    data.promptTemplate = normalizePromptTemplate(data.promptTemplate);
  } else {
    data.promptTemplate = [];
  }
}
