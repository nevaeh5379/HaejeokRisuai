import { describe, expect, test } from "vitest";
import type { ChatGenerationOverrides } from "../process/chatGenerationContext";
import {
  buildRisuAgentGenerationOverrides,
  createDefaultRisuAgentPromptConfig,
  createDefaultRisuAgentPromptSettings,
  isRisuAgentPromptEnabled,
  normalizeRisuAgentPromptConfig,
} from "./risuAgentPrompt";

describe("Risu Agent prompt config defaults", () => {
  test("missing or legacy data normalizes to null (pre-feature behavior)", () => {
    expect(normalizeRisuAgentPromptConfig(undefined)).toBeNull();
    expect(normalizeRisuAgentPromptConfig(null)).toBeNull();
    expect(normalizeRisuAgentPromptConfig({})).toBeNull();
    expect(normalizeRisuAgentPromptConfig("nope")).toBeNull();
    expect(normalizeRisuAgentPromptConfig(42)).toBeNull();
    expect(normalizeRisuAgentPromptConfig([])).toBeNull();
  });

  test("default settings match the canonical preset defaults", () => {
    const settings = createDefaultRisuAgentPromptSettings();
    expect(settings).toEqual({
      assistantPrefill: "",
      postEndInnerFormat: "",
      sendChatAsSystem: false,
      sendName: false,
      utilOverride: false,
      customChainOfThought: false,
      maxThoughtTagDepth: -1,
      trimStartNewChat: false,
    });
  });

  test("a fresh config is isolated and disabled by default", () => {
    const config = createDefaultRisuAgentPromptConfig();
    expect(config.promptTemplate).toEqual([]);
    expect(config.promptSettings.utilOverride).toBe(false);
    expect(isRisuAgentPromptEnabled(config)).toBe(false);
  });

  test("default config deep-clones the supplied template", () => {
    const template: any[] = [{ type: "plain", text: "hello", role: "system" }];
    const config = createDefaultRisuAgentPromptConfig(template);
    template[0].text = "mutated";
    expect((config.promptTemplate[0] as any).text).toBe("hello");
  });
});

describe("Risu Agent prompt config normalization", () => {
  test("drops malformed cards and coerces malformed settings", () => {
    const config = normalizeRisuAgentPromptConfig({
      promptTemplate: [
        { type: "chat", rangeStart: 0, rangeEnd: "end" },
        { notAType: true },
        null,
        "string",
        { type: "" },
      ],
      promptSettings: {
        utilOverride: "yes",
        sendName: 1,
        maxThoughtTagDepth: Number.NaN,
        postEndInnerFormat: 5,
        unknownKey: "ignored",
      },
    });

    expect(config).not.toBeNull();
    expect(config!.promptTemplate).toHaveLength(1);
    expect(config!.promptTemplate[0].type).toBe("chat");
    expect(config!.promptSettings.utilOverride).toBe(false);
    expect(config!.promptSettings.sendName).toBe(false);
    expect(config!.promptSettings.maxThoughtTagDepth).toBe(-1);
    expect(config!.promptSettings.postEndInnerFormat).toBe("");
    expect(
      (config!.promptSettings as Record<string, unknown>).unknownKey,
    ).toBeUndefined();
  });

  test("keeps partial data instead of discarding it", () => {
    const config = normalizeRisuAgentPromptConfig({
      promptSettings: { utilOverride: true, sendChatAsSystem: true },
    });
    expect(config).not.toBeNull();
    expect(config!.promptTemplate).toEqual([]);
    expect(config!.promptSettings.utilOverride).toBe(true);
    expect(config!.promptSettings.sendChatAsSystem).toBe(true);
    expect(config!.promptSettings.sendName).toBe(false);
  });

  test("template-only data stays disabled until utilOverride is on", () => {
    const config = normalizeRisuAgentPromptConfig({
      promptTemplate: [{ type: "chat", rangeStart: 0, rangeEnd: "end" }],
    });
    expect(config).not.toBeNull();
    expect(isRisuAgentPromptEnabled(config)).toBe(false);
  });
});

describe("Risu Agent generation overrides", () => {
  test("no override while disabled, so the preset values are used", () => {
    const overrides: ChatGenerationOverrides | undefined =
      buildRisuAgentGenerationOverrides(undefined);
    expect(overrides).toBeUndefined();
    expect(
      buildRisuAgentGenerationOverrides({
        promptTemplate: [{ type: "plain", text: "x", role: "system" }],
        promptSettings: { utilOverride: false },
      }),
    ).toBeUndefined();
  });

  test("enabled config yields a request-local deep clone", () => {
    const stored = {
      promptTemplate: [{ type: "plain", text: "agent", role: "system" }],
      promptSettings: { utilOverride: true, sendName: true },
    };
    const overrides = buildRisuAgentGenerationOverrides(stored);
    expect(overrides).not.toBeUndefined();
    expect(overrides!.promptTemplate).toHaveLength(1);
    expect(overrides!.promptSettings?.utilOverride).toBe(true);
    expect(overrides!.promptSettings?.sendName).toBe(true);
    expect(overrides!.promptSettings?.maxThoughtTagDepth).toBe(-1);

    // Mutating the request payload must not touch persisted data...
    (overrides!.promptTemplate as any[])[0].text = "mutated";
    expect((stored.promptTemplate[0] as any).text).toBe("agent");
    // ...and the payload must not be affected by later config edits.
    (stored.promptTemplate[0] as any).text = "edited later";
    expect((overrides!.promptTemplate as any[])[0].text).toBe("mutated");
  });

  test("an empty template becomes null so history is preserved", () => {
    const overrides = buildRisuAgentGenerationOverrides({
      promptTemplate: [],
      promptSettings: { utilOverride: true },
    });
    expect(overrides).not.toBeUndefined();
    expect(overrides!.promptTemplate).toBeNull();
  });

  test("the returned payload never carries preset-store references", () => {
    const stored = {
      promptTemplate: [{ type: "cache", name: "x", depth: 1, role: "all" }],
      promptSettings: { utilOverride: true, customChainOfThought: true },
    };
    const overrides = buildRisuAgentGenerationOverrides(stored);
    expect(overrides!.promptTemplate).not.toBe(stored.promptTemplate);
    expect(overrides!.promptSettings).not.toBe(stored.promptSettings);
  });
});
