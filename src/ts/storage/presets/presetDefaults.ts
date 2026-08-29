import { defaultJailbreak, defaultMainPrompt } from "./defaultPrompts";
import { safeStructuredClone } from "../../polyfill";
import type { AINsettings, botPreset, OobaSettings } from "../database/schema";

export const defaultAIN: AINsettings = {
  top_p: 0.7,
  rep_pen: 1.0625,
  top_a: 0.08,
  rep_pen_slope: 1.7,
  rep_pen_range: 1024,
  typical_p: 1.0,
  badwords: "",
  stoptokens: "",
  top_k: 140,
};

export const defaultOoba: OobaSettings = {
  max_new_tokens: 180,
  do_sample: true,
  temperature: 0.7,
  top_p: 0.9,
  typical_p: 1,
  repetition_penalty: 1.15,
  encoder_repetition_penalty: 1,
  top_k: 20,
  min_length: 0,
  no_repeat_ngram_size: 0,
  num_beams: 1,
  penalty_alpha: 0,
  length_penalty: 1,
  early_stopping: false,
  seed: -1,
  add_bos_token: true,
  truncation_length: 4096,
  ban_eos_token: false,
  skip_special_tokens: true,
  top_a: 0,
  tfs: 1,
  epsilon_cutoff: 0,
  eta_cutoff: 0,
  formating: {
    header:
      "Below is an instruction that describes a task. Write a response that appropriately completes the request.",
    systemPrefix: "### Instruction:",
    userPrefix: "### Input:",
    assistantPrefix: "### Response:",
    seperator: "",
    useName: false,
  },
};

export const presetTemplate: botPreset = {
  name: "New Preset",
  apiType: "gemini-3-flash-preview",
  openAIKey: "",
  localNetworkMode: false,
  localNetworkTimeoutSec: 600,
  mainPrompt: defaultMainPrompt,
  jailbreak: defaultJailbreak,
  globalNote: "",
  temperature: 80,
  maxContext: 4000,
  maxResponse: 300,
  frequencyPenalty: 70,
  PresensePenalty: 70,
  formatingOrder: [
    "main",
    "description",
    "personaPrompt",
    "chats",
    "lastChat",
    "jailbreak",
    "lorebook",
    "globalNote",
    "authorNote",
  ],
  aiModel: "gemini-3-flash-preview",
  subModel: "gemini-3-flash-preview",
  currentPluginProvider: "",
  textgenWebUIStreamURL: "",
  textgenWebUIBlockingURL: "",
  forceReplaceUrl: "",
  forceReplaceUrl2: "",
  promptPreprocess: false,
  proxyKey: "",
  bias: [],
  ooba: safeStructuredClone(defaultOoba),
  ainconfig: safeStructuredClone(defaultAIN),
  reverseProxyOobaArgs: {
    mode: "instruct",
  },
  top_p: 1,
  useInstructPrompt: false,
  verbosity: 1,
};

const defaultSdData: [string, string][] = [
  ["always", "solo, 1girl"],
  ["negative", ""],
  ["|character\'s appearance", ""],
  ["current situation", ""],
  ["$character's pose", ""],
  ["$character's emotion", ""],
  ["current location", ""],
];

export const defaultSdDataFunc = () => {
  return safeStructuredClone(defaultSdData);
};


