import type {
  HypaV3Preset,
  HypaV3Settings,
} from "../../../../packages/protocol/domain/hypav3Preset.ts";

export function createHypaV3Preset(
  name = "New Preset",
  existingSettings: Partial<HypaV3Settings> = {},
): HypaV3Preset {
  const settings: HypaV3Settings = {
    summarizationPrompt: "",
    reSummarizationPrompt: "",
    memoryTokensRatio: 0.2,
    extraSummarizationRatio: 0,
    maxChatsPerSummary: 6,
    recentMemoryRatio: 0.4,
    similarMemoryRatio: 0.4,
    enableSimilarityCorrection: false,
    preserveOrphanedMemory: false,
    processRegexScript: false,
    doNotSummarizeUserMessage: false,
    summaryChunkSeparator: "\\n\\n",
    useExperimentalImpl: false,
    summarizationRequestsPerMinute: 20,
    summarizationMaxConcurrent: 1,
    embeddingRequestsPerMinute: 100,
    embeddingMaxConcurrent: 1,
    alwaysToggleOn: false,
    queryChatCount: 3,
  };

  if (
    existingSettings &&
    typeof existingSettings === "object" &&
    !Array.isArray(existingSettings)
  ) {
    const existing = existingSettings as Record<string, unknown>;
    for (const key of Object.keys(existing)) {
      const value = existing[key];
      const settingKey = key as keyof HypaV3Settings;
      if (
        settingKey in settings &&
        typeof value === typeof settings[settingKey]
      ) {
        (settings as unknown as Record<string, unknown>)[settingKey] = value;
      }
    }
  }

  return { name, settings };
}
