import { afterAll, describe, expect, it } from "vitest";

import { countTokensBatch, disposeEncoders } from "./tokenizeCount.ts";

afterAll(() => disposeEncoders());

describe("server token counting", async () => {
  it("counts batches with both supported tiktoken encodings", async () => {
    expect(
      await countTokensBatch(["hello world", "안녕하세요"], "cl100k_base"),
    ).toEqual([2, 5]);
    expect(
      await countTokensBatch(["hello world", "안녕하세요"], "o200k_base"),
    ).toEqual([2, 2]);
  });

  it("rejects unsupported encodings", async () => {
    await expect(countTokensBatch(["hello"], "bad" as any)).rejects.toThrow(
      "Unsupported tokenizer encoding",
    );
  });
});
