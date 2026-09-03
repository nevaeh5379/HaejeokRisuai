import { describe, expect, it, vi } from "vitest";
import {
  calculateMultimodalTokenCost,
  countChatTokensDetailed,
} from "@risuai/chat-core/tokenAccounting.cjs";
import type { OpenAIChat } from "@risuai/chat-core/types.cjs";

const baseOptions = {
  chatAdditionalTokens: 3,
  useName: true,
  supportsInlayImage: true,
  visionQuality: "high",
};

describe("shared chat token accounting", () => {
  it("batches text counting and applies message, name, and thought overhead", async () => {
    const chats: OpenAIChat[] = [
      {
        role: "assistant",
        content: "hello",
        name: "Alice",
        thoughts: ["first", "second"],
      },
    ];
    const counter = vi.fn(async (texts: string[]) =>
      texts.map((text) => text.length),
    );
    const result = await countChatTokensDetailed(chats, counter, {
      ...baseOptions,
      countThoughts: true,
    });
    expect(counter).toHaveBeenCalledOnce();
    expect(counter).toHaveBeenCalledWith(["hello", "Alice", "first", "second"]);
    expect(result).toEqual([5 + 3 + 5 + 1 + 5 + 1 + 6 + 1]);
  });

  it("does not count names or thoughts when disabled", async () => {
    const chats: OpenAIChat[] = [
      { role: "user", content: "abc", name: "Ignored", thoughts: ["x"] },
    ];
    const result = await countChatTokensDetailed(
      chats,
      async (texts) => texts.map(() => 2),
      {
        ...baseOptions,
        useName: false,
        countThoughts: false,
      },
    );
    expect(result).toEqual([5]);
  });

  it("uses the additional-token fallback when image input is unsupported", () => {
    expect(
      calculateMultimodalTokenCost(
        { type: "image", base64: "" },
        {
          ...baseOptions,
          chatAdditionalTokens: 5,
          supportsInlayImage: false,
        },
      ),
    ).toBe(5);
  });

  it("uses the legacy fixed low-quality vision cost", () => {
    expect(
      calculateMultimodalTokenCost(
        { type: "image", base64: "", width: 4000, height: 4000 },
        {
          ...baseOptions,
          visionQuality: "low",
        },
      ),
    ).toBe(87);
  });

  it("preserves the existing high-quality image scaling formula", () => {
    expect(
      calculateMultimodalTokenCost(
        { type: "image", base64: "", width: 2048, height: 1024 },
        baseOptions,
      ),
    ).toBe(104);
    expect(
      calculateMultimodalTokenCost(
        { type: "image", base64: "", width: 2048, height: 2048 },
        baseOptions,
      ),
    ).toBe(96);
  });

  it("rejects malformed batch counter results", async () => {
    await expect(
      countChatTokensDetailed(
        [{ role: "user", content: "hello" }],
        async () => [],
        baseOptions,
      ),
    ).rejects.toThrow("invalid count array");
  });
});
