import rfdc from "rfdc";
const clone = rfdc();
import { createPresetSettings } from "@risuai/protocol/domain/presetSchema.ts";
import type { botPreset } from "@risuai/protocol/domain/database.ts";
export {
  defaultAIN,
  defaultOoba,
} from "@risuai/protocol/domain/providerDefaults.ts";
export const presetTemplate: botPreset = {
  ...createPresetSettings(),
  name: "New Preset",
  openAIKey: "",
  forceReplaceUrl2: "",
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
  return clone(defaultSdData);
};
