import { afterAll, describe, expect, it } from "vitest";

const { countTokensBatch, disposeEncoders } =
  require("./tokenizeCount.cjs") as {
    countTokensBatch: (
      texts: string[],
      encoding: "cl100k_base" | "o200k_base",
    ) => number[];
    disposeEncoders: () => void;
  };

afterAll(() => disposeEncoders());

describe("server token counting", () => {
  it("counts batches with both supported tiktoken encodings", () => {
    expect(
      countTokensBatch(["hello world", "안녕하세요"], "cl100k_base"),
    ).toEqual([2, 5]);
    expect(
      countTokensBatch(["hello world", "안녕하세요"], "o200k_base"),
    ).toEqual([2, 2]);
  });

  it("rejects unsupported encodings", () => {
    expect(() => countTokensBatch(["hello"], "bad" as any)).toThrow(
      "Unsupported tokenizer encoding",
    );
  });
});
