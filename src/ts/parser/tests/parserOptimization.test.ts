import { describe, expect, it } from "vitest";
import { getDistance, risuChatParser } from "../parser.svelte";
import { parseChatML } from "../chatML";
import { templateCheck } from "../../process/templates/templateCheck";
import type { PromptItem } from "../../process/prompt";

describe("getDistance Levenshtein optimizations", () => {
  it("returns 0 for identical strings", () => {
    expect(getDistance("", "")).toBe(0);
    expect(getDistance("hello", "hello")).toBe(0);
    expect(getDistance("risuai", "risuai")).toBe(0);
  });

  it("handles empty string transitions", () => {
    expect(getDistance("", "abc")).toBe(3);
    expect(getDistance("abc", "")).toBe(3);
  });

  it("calculates correct edit distances for classical examples", () => {
    expect(getDistance("kitten", "sitting")).toBe(3);
    expect(getDistance("saturday", "sunday")).toBe(3);
    expect(getDistance("rosettacode", "raisethysword")).toBe(8);
  });

  it("handles insertions, deletions, and substitutions symmetrically", () => {
    expect(getDistance("abc", "ab")).toBe(1);
    expect(getDistance("ab", "abc")).toBe(1);
    expect(getDistance("abc", "axc")).toBe(1);
  });
});

describe("risuChatParser fast paths and chunking", () => {
  it("returns plain text immediately when no macros or tags are present", () => {
    const plain = "Hello noble user! This is plain text without braces.";
    expect(risuChatParser(plain)).toBe(plain);
  });

  it("handles basic template macros without corruption", () => {
    const input = "Hello {{user}}!";
    const result = risuChatParser(input);
    expect(result).toBe("Hello User!");
  });

  it("handles contiguous text surrounding macros correctly", () => {
    const input =
      "Prefix text with many characters here: {{char}} and suffix text here.";
    const result = risuChatParser(input, {
      chara: {
        name: "Explorer",
      } as any,
    });
    expect(result).toBe(
      "Prefix text with many characters here: Explorer and suffix text here.",
    );
  });
});

describe("templateCheck set lookups", () => {
  it("detects disconnected chat ranges using set lookups", () => {
    const template: PromptItem[] = [
      { type: "plain", type2: "main", text: "Main", role: "system" },
      { type: "plain", type2: "globalNote", text: "Note", role: "system" },
      { type: "description" },
      { type: "lorebook" },
      { type: "chat", rangeStart: 0, rangeEnd: -4 },
      { type: "chat", rangeStart: -2, rangeEnd: "end" },
    ];

    const warnings = templateCheck(template);
    expect(warnings.some((w) => w.includes("Chat are not connected"))).toBe(
      true,
    );
  });

  it("passes when chat ranges connect seamlessly", () => {
    const template: PromptItem[] = [
      { type: "plain", type2: "main", text: "Main", role: "system" },
      { type: "plain", type2: "globalNote", text: "Note", role: "system" },
      { type: "description" },
      { type: "lorebook" },
      { type: "chat", rangeStart: 0, rangeEnd: -4 },
      { type: "chat", rangeStart: -4, rangeEnd: "end" },
    ];

    const warnings = templateCheck(template);
    expect(warnings.some((w) => w.includes("Chat are not connected"))).toBe(
      false,
    );
  });
});

describe("parseChatML single pass optimization", () => {
  it("parses multiple ChatML blocks efficiently", () => {
    const chatml =
      "<|im_start|>system<|im_sep|>You are an AI.<|im_end|><|im_start|>user<|im_sep|>Hello world!<|im_end|>";
    const parsed = parseChatML(chatml);
    expect(parsed).toEqual([
      { role: "system", content: "You are an AI.", thoughts: [] },
      { role: "user", content: "Hello world!", thoughts: [] },
    ]);
  });
});
