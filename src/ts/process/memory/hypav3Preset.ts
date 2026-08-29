export interface HypaV3Preset {
  name: string;
  settings: HypaV3Settings;
}

export interface HypaV3Settings {
  summarizationPrompt: string;
  reSummarizationPrompt: string;
  memoryTokensRatio: number;
  extraSummarizationRatio: number;
  maxChatsPerSummary: number;
  recentMemoryRatio: number;
  similarMemoryRatio: number;
  enableSimilarityCorrection: boolean;
  preserveOrphanedMemory: boolean;
  processRegexScript: boolean;
  doNotSummarizeUserMessage: boolean;
  summaryChunkSeparator: string;
  useExperimentalImpl: boolean;
  summarizationRequestsPerMinute: number;
  summarizationMaxConcurrent: number;
  embeddingRequestsPerMinute: number;
  embeddingMaxConcurrent: number;
  alwaysToggleOn: boolean;
  queryChatCount: number;
}

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
    for (const [key, value] of Object.entries(existingSettings)) {
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
