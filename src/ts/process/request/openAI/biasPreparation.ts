import { strongBan, tokenizeNum } from "../../../tokenizer";

export async function prepareOpenAILogitBias(
  biasStrings: [string, number][],
  initialBias: Record<number, number>,
): Promise<Record<number, number>> {
  let bias = initialBias;
  for (const [text, value] of biasStrings) {
    if (text.startsWith("[[") && text.endsWith("]]")) {
      const tokenId = parseInt(text.slice(2, -2));
      bias[tokenId] = value;
      continue;
    }

    if (value === -101) {
      bias = await strongBan(text, bias);
      continue;
    }

    const tokens = await tokenizeNum(text);
    for (const token of tokens) {
      bias[token] = value;
    }
  }
  return bias;
}
