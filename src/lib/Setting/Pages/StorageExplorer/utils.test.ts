import { describe, expect, it, beforeEach } from "vitest";
import {
  isThumbnailKey,
  extractOriginalKeyFromThumbnail,
  generateKeyCandidates,
  runStorageAnalysis,
  sortAssetFiles,
} from "./utils";
import { characterStore } from "src/ts/stores/domain/characterStore.svelte";
import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { moduleStore } from "src/ts/stores/domain/moduleStore.svelte";
import { personaStore } from "src/ts/stores/domain/personaStore.svelte";
import { language } from "src/lang";
import type { NodeStorageAssetDetails, NodeStorageAssetItem } from "./types";

describe("StorageExplorer utils", () => {
  describe("isThumbnailKey", () => {
    it("identifies thumbnail keys correctly", () => {
      expect(isThumbnailKey("thumbnails/assets/bot1.png_128x128.webp")).toBe(
        true,
      );
      expect(isThumbnailKey("thumbnails/bot1.png_128x128.webp")).toBe(true);
      expect(
        isThumbnailKey("thumbnails/subfolder/image.png_512x768.webp"),
      ).toBe(true);
      expect(isThumbnailKey("thumbnails/custom_thumb")).toBe(true);
    });

    it("returns false for non-thumbnail keys", () => {
      expect(isThumbnailKey("assets/bot1.png")).toBe(false);
      expect(isThumbnailKey("bot1.png")).toBe(false);
      expect(isThumbnailKey("customBackground.jpg")).toBe(false);
      expect(isThumbnailKey("")).toBe(false);
      expect(isThumbnailKey(null as any)).toBe(false);
      expect(isThumbnailKey(undefined as any)).toBe(false);
    });
  });

  describe("extractOriginalKeyFromThumbnail", () => {
    it("extracts original asset keys from standard thumbnail paths", () => {
      expect(
        extractOriginalKeyFromThumbnail(
          "thumbnails/assets/bot1.png_128x128.webp",
        ),
      ).toBe("assets/bot1.png");
      expect(
        extractOriginalKeyFromThumbnail("thumbnails/bot1.png_128x128.webp"),
      ).toBe("bot1.png");
      expect(
        extractOriginalKeyFromThumbnail(
          "thumbnails/assets/nested/image.jpeg_256x256.webp",
        ),
      ).toBe("assets/nested/image.jpeg");
      expect(
        extractOriginalKeyFromThumbnail(
          "thumbnails/assets/image.webp_128x128.webp",
        ),
      ).toBe("assets/image.webp");
    });

    it("falls back gracefully if no dimension suffix is present", () => {
      expect(
        extractOriginalKeyFromThumbnail("thumbnails/custom_image.png"),
      ).toBe("custom_image.png");
    });

    it("returns null for non-thumbnail keys", () => {
      expect(extractOriginalKeyFromThumbnail("assets/bot1.png")).toBeNull();
      expect(extractOriginalKeyFromThumbnail("bot1.png")).toBeNull();
      expect(extractOriginalKeyFromThumbnail("")).toBeNull();
    });
  });

  describe("generateKeyCandidates", () => {
    it("generates asset-prefixed and unprefixed key candidates", () => {
      expect(generateKeyCandidates("bot1.png")).toEqual([
        "bot1.png",
        "assets/bot1.png",
      ]);
      expect(generateKeyCandidates("assets/bot1.png")).toEqual([
        "assets/bot1.png",
        "bot1.png",
      ]);
    });
  });

  describe("runStorageAnalysis", () => {
    beforeEach(() => {
      // Reset stores
      characterStore.characters = [];
      moduleStore.modules = [];
      personaStore.personas = [
        {
          name: "User",
          icon: "",
          personaPrompt: "",
          note: "",
          largePortrait: false,
        },
      ];
      personaStore.activeIndex = 0;
      personaStore.loaded = true;
      settingsStore.state.customBackground = "";
      settingsStore.state.characterOrder = [];
    });

    it("does not treat thumbnails of referenced bot assets as orphan assets", async () => {
      // Setup active bot
      characterStore.characters = [
        {
          chaId: "char-1",
          name: "Active Bot",
          image: "assets/bot1.png",
          emotionImages: [["happy", "assets/bot1_happy.png"]],
          additionalAssets: [["bg", "assets/bot1_extra.png"]],
          customBackground: "bot1_bg.png",
          vits: {
            files: {
              greeting: "assets/voice_greeting.wav",
            },
          },
        } as any,
      ];

      // Storage contains bot assets, their thumbnails, and an unreferenced asset with its thumbnail
      const storageAssets: NodeStorageAssetItem[] = [
        { key: "assets/bot1.png", size: 1000, mtime: 1 },
        { key: "thumbnails/assets/bot1.png_128x128.webp", size: 100, mtime: 1 },
        { key: "assets/bot1_happy.png", size: 800, mtime: 1 },
        {
          key: "thumbnails/assets/bot1_happy.png_128x128.webp",
          size: 80,
          mtime: 1,
        },
        { key: "assets/bot1_extra.png", size: 600, mtime: 1 },
        { key: "bot1_bg.png", size: 1200, mtime: 1 },
        { key: "thumbnails/bot1_bg.png_128x128.webp", size: 120, mtime: 1 },
        { key: "assets/voice_greeting.wav", size: 3000, mtime: 1 },
        // Unreferenced orphan assets
        { key: "assets/deleted_bot.png", size: 2000, mtime: 1 },
        {
          key: "thumbnails/assets/deleted_bot.png_128x128.webp",
          size: 200,
          mtime: 1,
        },
      ];

      const assetMap = new Map<string, NodeStorageAssetItem>();
      for (const item of storageAssets) {
        assetMap.set(item.key, item);
      }

      const assetDetails: NodeStorageAssetDetails = {
        storageType: "s3",
        totalObjects: storageAssets.length,
        totalSizeBytes: storageAssets.reduce((sum, a) => sum + a.size, 0),
        assets: storageAssets,
      };

      const result = await runStorageAnalysis(assetMap, assetDetails);

      // Bots analysis
      expect(result.bots.length).toBe(1);
      expect(result.bots[0].name).toBe("Active Bot");
      expect(result.bots[0].totalAssets).toBe(5); // avatar, happy, extra, bg, vits audio

      // Orphan assets should ONLY be the deleted bot image and its thumbnail
      const orphanKeys = result.orphanAssets.map((a) => a.key);
      expect(orphanKeys).toEqual([
        "assets/deleted_bot.png",
        "thumbnails/assets/deleted_bot.png_128x128.webp",
      ]);
      expect(result.orphanSizeBytes).toBe(2200); // 2000 + 200
    });

    it("keeps assets referenced only by character snapshots out of the orphan list", async () => {
      characterStore.characters = [
        {
          chaId: "char-snapshot",
          name: "Snapshot Bot",
          snapshotAssetRefs: ["assets/old-avatar.png"],
        } as any,
      ];

      const storageAssets: NodeStorageAssetItem[] = [
        { key: "assets/old-avatar.png", size: 1000, mtime: 1 },
        { key: "assets/orphan.png", size: 500, mtime: 1 },
      ];
      const assetMap = new Map(storageAssets.map((item) => [item.key, item]));
      const result = await runStorageAnalysis(assetMap, {
        storageType: "s3",
        totalObjects: storageAssets.length,
        totalSizeBytes: 1500,
        assets: storageAssets,
      });

      expect(result.orphanAssets.map((asset) => asset.key)).toEqual([
        "assets/orphan.png",
      ]);
      expect(result.bots[0].assets.some((asset) => asset.key === "assets/old-avatar.png")).toBe(true);
    });

    it("correctly protects persona icons and the global background from orphan classification", async () => {
      personaStore.personas = [
        {
          id: "p1",
          name: "User Persona",
          icon: "persona_icon.png",
          personaPrompt: "",
          note: "",
          largePortrait: false,
        },
      ];
      settingsStore.state.customBackground = "assets/global_bg.jpg";

      const storageAssets: NodeStorageAssetItem[] = [
        { key: "persona_icon.png", size: 500, mtime: 1 },
        { key: "thumbnails/persona_icon.png_128x128.webp", size: 50, mtime: 1 },
        { key: "assets/global_bg.jpg", size: 1500, mtime: 1 },
        { key: "assets/truly_unused.png", size: 900, mtime: 1 },
      ];

      const assetMap = new Map<string, NodeStorageAssetItem>();
      for (const item of storageAssets) {
        assetMap.set(item.key, item);
      }

      const assetDetails: NodeStorageAssetDetails = {
        storageType: "s3",
        totalObjects: storageAssets.length,
        totalSizeBytes: storageAssets.reduce((sum, a) => sum + a.size, 0),
        assets: storageAssets,
      };

      const result = await runStorageAnalysis(assetMap, assetDetails);

      const orphanKeys = result.orphanAssets.map((a) => a.key);
      expect(orphanKeys).toEqual(["assets/truly_unused.png"]);
      expect(result.orphanSizeBytes).toBe(900);
    });

    it("correctly detects missing bot and module assets that do not exist in storage", async () => {
      characterStore.characters = [
        {
          chaId: "char-missing",
          name: "Missing Assets Bot",
          image: "assets/present_avatar.png",
          emotionImages: [
            ["happy", "assets/missing_happy.png"],
            ["sad", "assets/present_sad.png"],
          ],
          additionalAssets: [["bg_extra", "assets/missing_extra.png"]],
        } as any,
      ];

      moduleStore.modules = [
        {
          id: "mod-1",
          name: "Test Module",
          icon: "assets/missing_icon.png",
          assets: [["sound", "assets/present_sound.mp3"]],
        } as any,
      ];

      const storageAssets: NodeStorageAssetItem[] = [
        { key: "assets/present_avatar.png", size: 1200, mtime: 1 },
        { key: "assets/present_sad.png", size: 800, mtime: 1 },
        { key: "assets/present_sound.mp3", size: 3500, mtime: 1 },
      ];

      const assetMap = new Map<string, NodeStorageAssetItem>();
      for (const item of storageAssets) {
        assetMap.set(item.key, item);
      }

      const assetDetails: NodeStorageAssetDetails = {
        storageType: "s3",
        totalObjects: storageAssets.length,
        totalSizeBytes: 5500,
        assets: storageAssets,
      };

      const result = await runStorageAnalysis(assetMap, assetDetails);

      // Bot checks
      expect(result.bots.length).toBe(1);
      const bot = result.bots[0];
      expect(bot.totalAssets).toBe(4); // avatar, happy, sad, bg_extra
      expect(bot.missingAssetsCount).toBe(2); // missing_happy, missing_extra
      expect(
        bot.assets.find((a) => a.key === "assets/present_avatar.png")?.missing,
      ).toBe(false);
      expect(
        bot.assets.find((a) => a.key === "assets/present_sad.png")?.missing,
      ).toBe(false);
      expect(
        bot.assets.find((a) => a.key === "assets/missing_happy.png")?.missing,
      ).toBe(true);
      expect(
        bot.assets.find((a) => a.key === "assets/missing_extra.png")?.missing,
      ).toBe(true);

      // Module checks
      expect(result.modules.length).toBe(1);
      const mod = result.modules[0];
      expect(mod.totalAssets).toBe(2); // icon, sound
      expect(mod.missingAssetsCount).toBe(1); // missing_icon
      expect(
        mod.assets.find((a) => a.key === "assets/missing_icon.png")?.missing,
      ).toBe(true);
      expect(
        mod.assets.find((a) => a.key === "assets/present_sound.mp3")?.missing,
      ).toBe(false);

      // Total missing count
      expect(result.totalMissingAssets).toBe(3); // 2 bot + 1 module
    });

    it("correctly populates originalName on BotAssetItem and records assetUsageMap", async () => {
      characterStore.characters = [
        {
          chaId: "char-test",
          name: "Test Character",
          image: "assets/hex_avatar_12345.png",
          emotionImages: [["happy_face", "assets/hex_emo_smile_999.png"]],
          additionalAssets: [
            ["sword_slash.png", "assets/hex_add_sword_888.png", "png"],
          ],
          ccAssets: [
            {
              name: "magic_wand.png",
              uri: "assets/hex_cc_wand_777.png",
              ext: "png",
            },
          ],
        } as any,
      ];

      moduleStore.modules = [
        {
          id: "mod-test",
          name: "Test Plugin Module",
          icon: "assets/hex_mod_icon_666.png",
          assets: [["battle_theme.mp3", "assets/hex_mod_audio_555.mp3", "mp3"]],
        } as any,
      ];

      const storageAssets: NodeStorageAssetItem[] = [
        { key: "assets/hex_avatar_12345.png", size: 1000, mtime: 1 },
        { key: "assets/hex_emo_smile_999.png", size: 500, mtime: 1 },
        { key: "assets/hex_add_sword_888.png", size: 800, mtime: 1 },
        { key: "assets/hex_cc_wand_777.png", size: 600, mtime: 1 },
        { key: "assets/hex_mod_icon_666.png", size: 400, mtime: 1 },
        { key: "assets/hex_mod_audio_555.mp3", size: 5000, mtime: 1 },
      ];

      const assetMap = new Map<string, NodeStorageAssetItem>();
      for (const item of storageAssets) {
        assetMap.set(item.key, item);
      }

      const assetDetails: NodeStorageAssetDetails = {
        storageType: "s3",
        totalObjects: storageAssets.length,
        totalSizeBytes: 8300,
        assets: storageAssets,
      };

      const result = await runStorageAnalysis(assetMap, assetDetails);

      // Bot assets original names
      const bot = result.bots[0];
      const avatarAsset = bot.assets.find(
        (a) => a.key === "assets/hex_avatar_12345.png",
      );
      expect(avatarAsset?.originalName).toBe(
        language.storageMainAvatar || "Main Avatar",
      );

      const emoAsset = bot.assets.find(
        (a) => a.key === "assets/hex_emo_smile_999.png",
      );
      expect(emoAsset?.originalName).toBe("happy_face");

      const addAsset = bot.assets.find(
        (a) => a.key === "assets/hex_add_sword_888.png",
      );
      expect(addAsset?.originalName).toBe("sword_slash.png");
      expect(addAsset?.label).toBe("sword_slash.png");
      expect(addAsset?.extension).toBe("png");

      const ccAsset = bot.assets.find(
        (a) => a.key === "assets/hex_cc_wand_777.png",
      );
      expect(ccAsset?.originalName).toBe("magic_wand.png");

      // Module assets original names
      const mod = result.modules[0];
      const iconAsset = mod.assets.find(
        (a) => a.key === "assets/hex_mod_icon_666.png",
      );
      expect(iconAsset?.originalName).toBe(
        language.storageModuleIcon || "Module icon",
      );

      const modAsset = mod.assets.find(
        (a) => a.key === "assets/hex_mod_audio_555.mp3",
      );
      expect(modAsset?.originalName).toBe("battle_theme.mp3");
      expect(modAsset?.label).toBe("battle_theme.mp3");
      expect(modAsset?.extension).toBe("mp3");

      // Check assetUsageMap
      expect(result.assetUsageMap).toBeDefined();
      const avatarUsage = result.assetUsageMap.get(
        "assets/hex_avatar_12345.png",
      );
      expect(avatarUsage).toBeDefined();
      expect(avatarUsage?.[0].ownerName).toBe("Test Character");
      expect(avatarUsage?.[0].originalName).toBe(
        language.storageMainAvatar || "Main Avatar",
      );

      const swordUsage = result.assetUsageMap.get(
        "assets/hex_add_sword_888.png",
      );
      expect(swordUsage).toBeDefined();
      expect(swordUsage?.[0].ownerName).toBe("Test Character");
      expect(swordUsage?.[0].originalName).toBe("sword_slash.png");

      const audioUsage = result.assetUsageMap.get(
        "assets/hex_mod_audio_555.mp3",
      );
      expect(audioUsage).toBeDefined();
      expect(audioUsage?.[0].ownerName).toBe("Test Plugin Module");
      expect(audioUsage?.[0].originalName).toBe("battle_theme.mp3");
    });
  });

  describe("sortAssetFiles", () => {
    const sampleFiles: NodeStorageAssetItem[] = [
      { key: "assets/file10.png", size: 500, mtime: 1 },
      { key: "assets/file2.png", size: 1200, mtime: 2 },
      { key: "assets/file1.png", size: 100, mtime: 3 },
      { key: "assets/avatar.jpg", size: 8000, mtime: 4 },
    ];

    it("sorts files by size descending (largest first)", () => {
      const sorted = sortAssetFiles(sampleFiles, "size_desc");
      expect(sorted.map((f) => f.key)).toEqual([
        "assets/avatar.jpg",
        "assets/file2.png",
        "assets/file10.png",
        "assets/file1.png",
      ]);
      expect(sorted.map((f) => f.size)).toEqual([8000, 1200, 500, 100]);
    });

    it("sorts files by size ascending (smallest first)", () => {
      const sorted = sortAssetFiles(sampleFiles, "size_asc");
      expect(sorted.map((f) => f.key)).toEqual([
        "assets/file1.png",
        "assets/file10.png",
        "assets/file2.png",
        "assets/avatar.jpg",
      ]);
      expect(sorted.map((f) => f.size)).toEqual([100, 500, 1200, 8000]);
    });

    it("sorts files by natural filename/key ascending (A-Z with numeric order)", () => {
      const sorted = sortAssetFiles(sampleFiles, "name_asc");
      expect(sorted.map((f) => f.key)).toEqual([
        "assets/avatar.jpg",
        "assets/file1.png",
        "assets/file2.png",
        "assets/file10.png",
      ]);
    });

    it("sorts files by natural filename/key descending (Z-A with numeric order)", () => {
      const sorted = sortAssetFiles(sampleFiles, "name_desc");
      expect(sorted.map((f) => f.key)).toEqual([
        "assets/file10.png",
        "assets/file2.png",
        "assets/file1.png",
        "assets/avatar.jpg",
      ]);
    });

    it("does not mutate the original array", () => {
      const originalKeys = sampleFiles.map((f) => f.key);
      sortAssetFiles(sampleFiles, "size_desc");
      expect(sampleFiles.map((f) => f.key)).toEqual(originalKeys);
    });
  });
});
