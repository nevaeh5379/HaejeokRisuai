import type { MultiModal, OpenAIChat } from "./types.cjs";

export interface ChatTokenAccountingOptions {
  chatAdditionalTokens: number;
  useName: boolean;
  countThoughts?: boolean;
  supportsInlayImage: boolean;
  visionQuality?: string;
}

export function calculateMultimodalTokenCost(
  data: MultiModal,
  options: ChatTokenAccountingOptions,
): number;

export function countChatTokensDetailed(
  chats: readonly OpenAIChat[],
  countTexts: (texts: string[]) => Promise<number[]>,
  options: ChatTokenAccountingOptions,
): Promise<number[]>;
