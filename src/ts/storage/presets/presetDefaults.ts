import rfdc from "rfdc";
const clone = rfdc();
import { createPresetSettings } from "./presetSchema";
import type { botPreset } from "../database/schema";
export { defaultAIN, defaultOoba } from "./providerDefaults";
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
