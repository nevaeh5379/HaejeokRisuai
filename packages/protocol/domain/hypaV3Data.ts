import type { OpenAIChat } from "../../chat-core/types.ts";
import type { HypaV3Settings } from "./hypav3Preset.ts";
import type { DisplayMode as ModalDisplayMode } from "./hypaV3DisplayMode.ts";

export interface HypaV3Data {
  summaries: Summary[];
  categories?: { id: string; name: string }[];
  lastSelectedSummaries?: number[]; // legacy
  metrics?: {
    lastImportantSummaries: number[];
    lastRecentSummaries: number[];
    lastSimilarSummaries: number[];
    lastRandomSummaries: number[];
  };
  modalSettings?: {
    displayMode: ModalDisplayMode;
    displayRangeFrom: number;
    displayRangeTo: number;
    displayRecentCount: number;
    displayImportant: boolean;
    displaySelected: boolean;
  };
}

export interface SerializableHypaV3Data extends Omit<HypaV3Data, "summaries"> {
  summaries: SerializableSummary[];
}

export interface Summary {
  text: string;
  chatMemos: Set<string>;
  isImportant: boolean;
  categoryId?: string;
  tags?: string[];
}

export interface SerializableSummary extends Omit<Summary, "chatMemos"> {
  chatMemos: string[];
}

export interface SummaryChunk {
  text: string;
  summary: Summary;
}

