export type HypaV3DisplayMode = "All" | "Range" | "Recent";

export interface HypaV3ModalSettings {
  displayMode: HypaV3DisplayMode;
  displayRangeFrom: number;
  displayRangeTo: number;
  displayRecentCount: number;
  displayImportant: boolean;
  displaySelected: boolean;
}

export interface HypaV3Metrics {
  lastImportantSummaries: number[];
  lastRecentSummaries: number[];
  lastSimilarSummaries: number[];
  lastRandomSummaries: number[];
}

export interface HypaV3Summary {
  text: string;
  chatMemos: Set<string | undefined>;
  isImportant: boolean;
  categoryId?: string;
  tags?: string[];
}

export interface SerializableHypaV3Summary extends Omit<
  HypaV3Summary,
  "chatMemos"
> {
  chatMemos: Array<string | null | undefined>;
}

export interface HypaV3Data {
  summaries: HypaV3Summary[];
  categories?: { id: string; name: string }[];
  /** @deprecated Retained only while loading older saves. */
  lastSelectedSummaries?: number[];
  metrics?: HypaV3Metrics;
  /** Application UI metadata. Engines may preserve this without interpreting it. */
  modalSettings?: HypaV3ModalSettings;
}

export interface SerializableHypaV3Data extends Omit<HypaV3Data, "summaries"> {
  summaries: SerializableHypaV3Summary[];
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

export interface HypaV3Preset {
  name: string;
  settings: HypaV3Settings;
}
