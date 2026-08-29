import { defaultJailbreak, defaultMainPrompt } from "../defaultPrompts";
import { safeStructuredClone } from "../../polyfill";
import type { Database, PortableDatabase } from "../schema";
import { presetTemplate } from "../presetDefaults";
import { normalizePromptTemplate } from "../presetService";
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
  username: defaultString("User"),
  userIcon: defaultString(),
  userNote: defaultString(),
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
  data.characters ??= [];
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
  const portableData = data as Database & Partial<PortableDatabase>;
  portableData.botPresets ??= [
    {
      ...safeStructuredClone(presetTemplate),
      name: "Default",
    },
  ];
  portableData.botPresetsId ??= 0;
  if (Array.isArray(data.promptTemplate)) {
    data.promptTemplate = normalizePromptTemplate(data.promptTemplate);
  } else {
    data.promptTemplate = [];
  }
}
