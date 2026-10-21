import { describe, expect, test } from "vitest";
import {
  findIllustrationMarkers,
  needsIllustrationTags,
  validIllustration,
  fitIllustrationPrompt,
  resolveIllustrationSettings,
  illustrationSourceHash,
  type Illustration,
  type IllustrationMessage,
} from "./illustration.ts";

describe("illustration protocol optimizations", () => {
  test("findIllustrationMarkers finds valid narrative markers and ignores code and reasoning", () => {
    const text =
      "Hello <Illustration> world.\n" +
      "```\n<Illustration> in code\n```\n" +
      "`<Illustration> in inline`\n" +
      "<thought><Illustration> in thought</thought>\n" +
      "Final scene <Illustration>";
    const markers = findIllustrationMarkers(text);
    expect(markers).toHaveLength(2);
    expect(text.startsWith("<Illustration>", markers[0])).toBe(true);
    expect(text.startsWith("<Illustration>", markers[1])).toBe(true);
  });

  test("needsIllustrationTags returns correct requirement without allocations", () => {
    const itemWithTags: Illustration = {
      id: "slot-1",
      token: "{{illustration::slot-1}}",
      status: "queued",
      version: 1,
      sourceHash: "test",
      executor: "app",
      runId: "run-1",
      tags: "scenic, sunset",
    };

    expect(needsIllustrationTags(itemWithTags, 1)).toBe(false);
    expect(needsIllustrationTags({ ...itemWithTags, tags: undefined }, 1)).toBe(true);
    expect(needsIllustrationTags(itemWithTags, 1, "rewrite")).toBe(true);
  });

  test("validIllustration validates unique token occurrence and hash", () => {
    const item: Illustration = {
      id: "slot-1",
      token: "{{illustration::slot-1}}",
      status: "queued",
      version: 1,
      sourceHash: "",
      branchId: "main",
      executor: "app",
      runId: "run-1",
    };

    const message: IllustrationMessage = {
      role: "char",
      data: "Before {{illustration::slot-1}} after.",
      illustrations: [item],
    };
    item.sourceHash = illustrationSourceHash(message);

    expect(validIllustration(message, item, "main", 1)).toBe(true);
    expect(validIllustration(message, item, "other", 1)).toBe(false);
    expect(validIllustration(message, item, "main", 2)).toBe(false);

    // Duplicated token
    const dupMessage: IllustrationMessage = {
      role: "char",
      data: "Before {{illustration::slot-1}} and {{illustration::slot-1}} after.",
      illustrations: [item],
    };
    expect(validIllustration(dupMessage, item, "main", 1)).toBe(false);
  });

  test("fitIllustrationPrompt trims dialogue until prompt fits context", async () => {
    const prompt = {
      required: [
        { role: "system" as const, content: "Instructions" },
        { role: "user" as const, content: "Current Scene" },
      ],
      history: [
        { role: "user" as const, content: "Old message 1" },
        { role: "assistant" as const, content: "Old message 2" },
        { role: "user" as const, content: "Recent message 3" },
      ],
    };

    const countTokens = async (messages: { content: string }[]) => {
      return messages.reduce((acc, m) => acc + m.content.length, 0);
    };

    // Limit context such that not all messages fit
    const totalRequiredLen = "Instructions".length + "Current Scene".length;
    const maxContext = totalRequiredLen + "Recent message 3".length + 300;

    const fitted = await fitIllustrationPrompt(prompt, countTokens, maxContext, 300);
    expect(fitted).toHaveLength(3); // system, recent message 3, user
    expect(fitted[0].content).toBe("Instructions");
    expect(fitted[1].content).toBe("Recent message 3");
    expect(fitted[2].content).toBe("Current Scene");
  });

  test("resolveIllustrationSettings merges instruction keys correctly", () => {
    const settings = resolveIllustrationSettings(
      { basePrompt: "masterpiece" },
      { basePrompt: "high quality" },
    );
    expect(settings.basePrompt).toBe("masterpiece\n\nhigh quality");
  });
});
