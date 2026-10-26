import { strongBan, tokenizeNum } from "../../../tokenizer";

export async function prepareOpenAILogitBias(
  biasStrings: [string, number][],
  initialBias: Record<number, number>,
): Promise<Record<number, number>> {
  let bias = initialBias;
  for (let i = 0; i < biasStrings.length; i++) {
    const entry = biasStrings[i];
    const text = entry[0];
    const value = entry[1];
    if (text.startsWith("[[") && text.endsWith("]]")) {
      const tokenId = parseInt(text.slice(2, -2), 10);
      bias[tokenId] = value;
      continue;
    }

    if (value === -101) {
      bias = await strongBan(text, bias);
      continue;
    }

    const tokens = await tokenizeNum(text);
    for (let j = 0; j < tokens.length; j++) {
      bias[tokens[j]] = value;
    }
  }
  return bias;
}
