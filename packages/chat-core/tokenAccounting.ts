import type { MultiModal, OpenAIChat } from "./types.ts";

export interface ChatTokenAccountingOptions {
  chatAdditionalTokens: number;
  useName: boolean;
  countThoughts?: boolean;
  supportsInlayImage: boolean;
  visionQuality?: string;
}
("use strict");

function calculateMultimodalTokenCost(
  data: MultiModal,
  options: ChatTokenAccountingOptions,
): number;
function calculateMultimodalTokenCost(data?: any, options?: any): any {
  if (!options.supportsInlayImage) return options.chatAdditionalTokens;
  if (options.visionQuality === "low") return 87;

  let encoded: any = options.chatAdditionalTokens;
  let height: any = data.height ?? 0;
  let width: any = data.width ?? 0;

  if (height === width) {
    if (height > 768) {
      height = 768;
      width = 768;
    }
  } else if (height > width) {
    if (width > 768) {
      width = 768;
      height *= 768 / width;
    }
  } else if (height > 768) {
    height = 768;
    width *= 768 / height;
  }

  const chunkSize: any = Math.ceil(width / 512) * Math.ceil(height / 512);
  return encoded + chunkSize * 2 + 85;
}

function countChatTokensDetailed(
  chats: readonly OpenAIChat[],
  countTexts: (texts: string[]) => Promise<number[]>,
  options: ChatTokenAccountingOptions,
): Promise<number[]>;
async function countChatTokensDetailed(
  chats?: any,
  countTexts?: any,
  options?: any,
): Promise<any> {
  const texts: any = [];
  for (const chat of chats) {
    texts.push(chat.content);
    if (chat.name && options.useName) texts.push(chat.name);
    if (options.countThoughts && chat.thoughts?.length)
      texts.push(...chat.thoughts);
  }

  const counts: any = await countTexts(texts);
  if (!Array.isArray(counts) || counts.length !== texts.length) {
    throw new TypeError("Text token counter returned an invalid count array");
  }

  let countIndex: any = 0;
  const detailed: any = [];
  for (const chat of chats) {
    let encoded: any = counts[countIndex++] + options.chatAdditionalTokens;
    if (chat.name && options.useName) encoded += counts[countIndex++] + 1;
    if (options.countThoughts && chat.thoughts?.length) {
      for (let i: any = 0; i < chat.thoughts.length; i++)
        encoded += counts[countIndex++] + 1;
    }
    for (const multimodal of chat.multimodals ?? []) {
      encoded += calculateMultimodalTokenCost(multimodal, options);
    }
    detailed.push(encoded);
  }
  return detailed;
}

export { calculateMultimodalTokenCost, countChatTokensDetailed };
