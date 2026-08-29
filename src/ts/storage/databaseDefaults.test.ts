import { describe, expect, it } from "vitest";
import type { Database, PortableDatabase } from "./schema";
import { normalizeDatabaseDefaults } from "./databaseDefaults";

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
    const db = {
      botPresets: [
        {
          promptTemplate: [],
          localNetworkMode: "invalid",
          localNetworkTimeoutSec: "invalid",
          openrouterProvider: "provider-a",
        },
      ],
    } as unknown as Database & Partial<PortableDatabase>;

    normalizeDatabaseDefaults(db);

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
});
