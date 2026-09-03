"use strict";

function calculateMultimodalTokenCost(data, options) {
  if (!options.supportsInlayImage) return options.chatAdditionalTokens;
  if (options.visionQuality === "low") return 87;

  let encoded = options.chatAdditionalTokens;
  let height = data.height ?? 0;
  let width = data.width ?? 0;

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

  const chunkSize = Math.ceil(width / 512) * Math.ceil(height / 512);
  return encoded + chunkSize * 2 + 85;
}

async function countChatTokensDetailed(chats, countTexts, options) {
  const texts = [];
  for (const chat of chats) {
    texts.push(chat.content);
    if (chat.name && options.useName) texts.push(chat.name);
    if (options.countThoughts && chat.thoughts?.length)
      texts.push(...chat.thoughts);
  }

  const counts = await countTexts(texts);
  if (!Array.isArray(counts) || counts.length !== texts.length) {
    throw new TypeError("Text token counter returned an invalid count array");
  }

  let countIndex = 0;
  const detailed = [];
  for (const chat of chats) {
    let encoded = counts[countIndex++] + options.chatAdditionalTokens;
    if (chat.name && options.useName) encoded += counts[countIndex++] + 1;
    if (options.countThoughts && chat.thoughts?.length) {
      for (let i = 0; i < chat.thoughts.length; i++)
        encoded += counts[countIndex++] + 1;
    }
    for (const multimodal of chat.multimodals ?? []) {
      encoded += calculateMultimodalTokenCost(multimodal, options);
    }
    detailed.push(encoded);
  }
  return detailed;
}

module.exports = {
  calculateMultimodalTokenCost,
  countChatTokensDetailed,
};
