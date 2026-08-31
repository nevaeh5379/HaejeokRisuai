import { describe, it, expect } from "vitest";
import {
  DOMAIN_REGISTRY,
  collectAllDomainAssets,
  ensureAllDomains,
  type CoreDomainKey,
} from "./domainRegistry.svelte";
import type { PortableDatabase } from "./schema";

describe("Domain Registry and Contract", () => {
  it("implements all required domain keys in DOMAIN_REGISTRY", () => {
    const requiredKeys: CoreDomainKey[] = [
      "characters",
      "personas",
      "modules",
      "botPresets",
      "pluginCustomStorage",
      "settings",
    ];

    for (const key of requiredKeys) {
      expect(DOMAIN_REGISTRY[key]).toBeDefined();
      expect(typeof DOMAIN_REGISTRY[key].collectAssets).toBe("function");
    }
  });

  it("collects module icon and assets correctly in all scope", () => {
    const mockDb: PortableDatabase = {
      username: "Tester",
      userIcon: "assets/user.png",
      customBackground: "assets/bg.png",
      characters: [
        {
          chaId: "char-1",
          type: "character",
          name: "Alice",
          image: "assets/alice.png",
          emotionImages: [["joy", "assets/alice-joy.png"]],
          additionalAssets: [["weapon", "assets/sword.png"]],
          chats: [],
        },
      ],
      personas: [{ name: "Hero", icon: "assets/hero.png" }],
      modules: [
        {
          id: "mod-1",
          name: "Spell Module",
          icon: "assets/spell-icon.png",
          assets: [["spellSound", "assets/fire.mp3"]],
        },
      ],
      botPresets: [{ name: "Default Preset", image: "assets/preset.png" }],
      botPresetsId: 0,
      characterOrder: [],
      pluginCustomStorage: {},
    } as any;

    const allAssets = collectAllDomainAssets(mockDb, "all");
    expect(allAssets.has("assets/spell-icon.png")).toBe(true);
    expect(allAssets.get("assets/spell-icon.png")?.charName).toBe("Module");
    expect(allAssets.has("assets/fire.mp3")).toBe(true);
    expect(allAssets.has("assets/alice-joy.png")).toBe(true);
    expect(allAssets.has("assets/hero.png")).toBe(true);
    expect(allAssets.has("assets/user.png")).toBe(true);

    const essentialAssets = collectAllDomainAssets(mockDb, "essential");
    expect(essentialAssets.has("assets/spell-icon.png")).toBe(true);
    expect(essentialAssets.has("assets/fire.mp3")).toBe(false); // only essential in essential scope
    expect(essentialAssets.has("assets/alice.png")).toBe(true);
    expect(essentialAssets.has("assets/preset.png")).toBe(true);
  });

  it("ensures missing domains are populated via ensureAllDomains", async () => {
    const sparseDb: PortableDatabase = {
      username: "Bob",
      userIcon: "assets/bob.png",
      customBackground: "",
      characters: [],
      personas: [],
      modules: [],
      botPresets: [],
      botPresetsId: 0,
      characterOrder: [],
      pluginCustomStorage: {},
    } as any;

    const populated = await ensureAllDomains(sparseDb);
    expect(Array.isArray(populated.characters)).toBe(true);
    expect(Array.isArray(populated.personas)).toBe(true);
    expect(populated.personas.length).toBeGreaterThan(0);
    expect(populated.personas[0].name).toBe("Bob");
    expect(Array.isArray(populated.modules)).toBe(true);
    expect(Array.isArray(populated.botPresets)).toBe(true);
    expect(populated.pluginCustomStorage).toBeDefined();
  });
});

