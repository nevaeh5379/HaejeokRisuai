import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  strongBan: vi.fn(),
  tokenizeNum: vi.fn(),
}));

vi.mock("../../../tokenizer", () => ({
  strongBan: mocks.strongBan,
  tokenizeNum: mocks.tokenizeNum,
}));

import { prepareOpenAILogitBias } from "./biasPreparation";

describe("OpenAI browser logit bias preparation", () => {
  beforeEach(() => {
    mocks.strongBan.mockReset();
    mocks.tokenizeNum.mockReset();
  });

  it("applies direct token ids without invoking the tokenizer", async () => {
    const result = await prepareOpenAILogitBias([["[[42]]", 7]], {});
    expect(result).toEqual({ 42: 7 });
    expect(mocks.tokenizeNum).not.toHaveBeenCalled();
    expect(mocks.strongBan).not.toHaveBeenCalled();
  });
  it("preserves strong-ban replacement before applying later tokenized biases", async () => {
    mocks.strongBan.mockResolvedValue({ 99: -100 });
    mocks.tokenizeNum.mockResolvedValue([5, 6]);

    const result = await prepareOpenAILogitBias([
      ["ban me", -101],
      ["boost me", 4],
    ], { 1: 2 });

    expect(mocks.strongBan).toHaveBeenCalledWith("ban me", { 1: 2 });
    expect(mocks.tokenizeNum).toHaveBeenCalledWith("boost me");
    expect(result).toEqual({
      5: 4,
      6: 4,
      99: -100,
    });
  });
});
