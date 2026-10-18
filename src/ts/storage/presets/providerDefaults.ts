import type { NAISettings } from "../../process/models/nai";
import type { AINsettings, OobaSettings } from "../database/schema";
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

export const defaultNAI: NAISettings = {
  topK: 12,
  topP: 0.85,
  topA: 0.1,
  tailFreeSampling: 0.915,
  repetitionPenalty: 2.8,
  repetitionPenaltyRange: 2048,
  repetitionPenaltySlope: 0.02,
  repostitionPenaltyPresence: 0,
  seperator: "",
  frequencyPenalty: 0.03,
  presencePenalty: 0,
  typicalp: 1,
  starter: "",
};
