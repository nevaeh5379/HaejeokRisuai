import { describe, expect, it } from "vitest";
import type { Database } from "./schema";
import {
  normalizeDatabaseDefaults,
  normalizeDatabaseInput,
  normalizeSettingsInput,
  type DatabaseInput,
} from "./databaseDefaults";

describe("normalizeDatabaseDefaults", () => {
  it("migrates legacy NovelAI v4 image settings", () => {
    const db = {
      NAIImgConfig: {
        v4_prompt: undefined,
        autoSmea: true,
        use_coords: true,
        legacy_uc: true,
      },
    } as unknown as Database;

    normalizeDatabaseDefaults(db);

    expect(db.NAIImgConfig.autoSmea).toBe(false);
    expect(db.NAIImgConfig.use_coords).toBe(false);
    expect(db.NAIImgConfig.legacy_uc).toBe(false);
    expect(db.NAIImgConfig.v4_prompt).toBeDefined();
    expect(db.NAIImgConfig.v4_negative_prompt).toBeDefined();
  });
  it("normalizes legacy provider settings inside portable presets", () => {
    const db = normalizeDatabaseInput({
      botPresets: [
        {
          promptTemplate: [],
          localNetworkMode: "invalid",
          localNetworkTimeoutSec: "invalid",
          openrouterProvider: "provider-a",
        },
      ],
    });

    const preset = db.botPresets?.[0];
    expect(preset?.localNetworkMode).toBe(false);
    expect(preset?.localNetworkTimeoutSec).toBe(600);
    expect(preset?.openrouterProvider).toEqual({
      order: ["provider-a"],
      only: [],
      ignore: [],
    });
  });
  it("migrates legacy streaming mode and clears transient chat state", () => {
    const db = {
      largeChatPerformanceMode: "strong",
      characters: [
        {
          chats: [
            {
              isStreaming: true,
              activeStreamingDisplayOptimizationMode: "strong",
            },
          ],
        },
      ],
    } as unknown as Database & { largeChatPerformanceMode?: string };

    normalizeDatabaseDefaults(db);

    expect(db.streamingDisplayOptimizationMode).toBe("strong");
    expect("largeChatPerformanceMode" in db).toBe(false);
    const chat = db.characters[0]?.chats?.[0];
    expect(chat?.isStreaming).toBe(false);
    expect(chat?.activeStreamingDisplayOptimizationMode).toBeUndefined();
  });

  it("repairs malformed scalar settings with Valibot defaults", () => {
    const db = normalizeDatabaseInput({
      maxContext: "not-a-number",
      swipe: "not-a-boolean",
      top_p: Number.NaN,
      settingsCloseButtonSize: "huge",
      keepSessionAlive: 123,
    });

    expect(db.maxContext).toBe(4000);
    expect(db.swipe).toBe(true);
    expect(db.top_p).toBe(1);
    expect(db.settingsCloseButtonSize).toBe(24);
    expect(db.keepSessionAlive).toBe("off");
  });

  it("keeps relational character data outside schema normalization", () => {
    const characters: Database["characters"] = [];
    const db = { characters } as unknown as Database;

    normalizeDatabaseDefaults(db);

    expect(db.characters).toBe(characters);
  });

  it("normalizes nested settings while preserving extension fields", () => {
    const db = normalizeDatabaseInput({
      promptSettings: {
        assistantPrefill: 123,
        trimStartNewChat: true,
      },
      sdConfig: {
        width: "invalid",
        customField: "keep-me",
      },
    });

    expect(db.promptSettings.assistantPrefill).toBe("");
    expect(db.promptSettings.trimStartNewChat).toBe(true);
    expect(db.sdConfig.width).toBe(512);
    expect((db.sdConfig as unknown as { customField?: string }).customField).toBe(
      "keep-me",
    );
  });

  it("repairs malformed OpenRouter provider arrays", () => {
    const db = normalizeDatabaseInput({
      openrouterProvider: {
        order: "invalid",
        only: ["valid", 123],
        ignore: null,
      },
    });

    expect(db.openrouterProvider).toEqual({
      order: [],
      only: [],
      ignore: [],
    });
  });

  it("normalizes sparse DatabaseInput without a Database assertion", () => {
    const input: DatabaseInput = {};
    const db = normalizeDatabaseDefaults(input);

    expect(db.maxContext).toBe(4000);
    expect(db.promptSettings.sendName).toBe(false);
    expect(db.openrouterProvider.order).toEqual([]);
  });

  it("keeps legacy persona mirrors out of runtime settings normalization", () => {
    const settings = normalizeSettingsInput({});
    for (const key of ["username", "userIcon", "userNote", "personaPrompt"]) {
      expect(Object.prototype.hasOwnProperty.call(settings, key)).toBe(false);
      expect(() => normalizeSettingsInput({ [key]: "legacy" })).toThrow(
        /owned by another domain store/,
      );
    }
  });

  it("rejects non-object unknown database roots", () => {
    expect(() => normalizeDatabaseInput(null)).toThrow(TypeError);
    expect(() => normalizeDatabaseInput([])).toThrow(TypeError);
    expect(() => normalizeDatabaseInput("database")).toThrow(TypeError);
  });

  it("repairs invalid enum-like settings", () => {
    const db = normalizeDatabaseInput({
      translatorType: "invalid",
      ollamaInputMode: "invalid",
      thinkingType: "invalid",
      keepSessionAlive: "invalid",
      customAPIFormat: 999,
    });

    expect(db.translatorType).toBe("google");
    expect(db.ollamaInputMode).toBe("manual");
    expect(db.thinkingType).toBe("budget");
    expect(db.keepSessionAlive).toBe("off");
    expect(db.customAPIFormat).toBe(0);
  });
});
