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
