// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { characterStore } from "./stores/domain/characterStore.svelte";
import type { character } from "./storage/database/schema";
import type { ISqlStorage } from "./storage/sql/ISqlStorage";

const alertCardExportMock = vi.fn();

vi.mock("./alert", () => ({
  alertError: vi.fn(),
  alertInput: vi.fn(),
  alertNormal: vi.fn(),
  alertSelect: vi.fn(),
  alertStore: { set: vi.fn() },
  alertCardExport: () => alertCardExportMock(),
}));

vi.mock("./globalApi.svelte", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./globalApi.svelte")>();
  return {
    ...actual,
    readImage: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
    saveAsset: vi.fn(async () => "asset-1"),
    downloadFile: vi.fn(async () => {}),
  };
});

vi.mock("./storage/files/persistant", () => ({
  readImage: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
  saveAsset: vi.fn(async () => "asset-1"),
  loadAsset: vi.fn(async () => new Uint8Array([5, 6, 7, 8])),
}));

vi.mock("./pngchunk", () => ({
  PngChunk: {
    streamWriter: class {
      constructor(
        public img: any,
        public writer: any,
      ) {}
      async init() {}
      async write(key: string, data: string) {
        if (key === "chara") {
          this.writer.data = data;
        }
      }
    },
  },
}));

vi.mock("./media", () => ({
  compressImage: vi.fn(async (buf: Uint8Array) => buf),
  reencodeImage: vi.fn(async (buf: Uint8Array) => buf),
}));

import { VirtualWriter } from "./globalApi.svelte";
import {
  createBaseV3,
  exportChar,
  exportCharacterCard,
} from "./characterCards";

describe("createBaseV3 asset packaging", () => {
  it("includes main icon asset even when emotionImages is undefined", () => {
    const char = {
      type: "character",
      chaId: "char-no-emotions",
      name: "No Emotions Char",
      image: "assets/char.png",
      emotionImages: undefined,
      ccAssets: [],
    } as unknown as character;

    const v3Card = createBaseV3(char);
    const mainIcon = v3Card.data.assets?.find(
      (asset) => asset.type === "icon" && asset.name === "main",
    );
    expect(mainIcon).toBeDefined();
    expect(mainIcon?.uri).toBe("ccdefault:");
  });

  it("includes main icon asset when emotionImages is empty array", () => {
    const char = {
      type: "character",
      chaId: "char-empty-emotions",
      name: "Empty Emotions Char",
      image: "assets/char.png",
      emotionImages: [],
      ccAssets: [],
    } as unknown as character;

    const v3Card = createBaseV3(char);
    const mainIcon = v3Card.data.assets?.find(
      (asset) => asset.type === "icon" && asset.name === "main",
    );
    expect(mainIcon).toBeDefined();
    expect(mainIcon?.uri).toBe("ccdefault:");
  });
});

describe("character export with shallow details", () => {
  let mockStorage: ISqlStorage;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage = {
      getRevision: vi.fn(() => 0),
      loadCharacter: vi.fn(async (id: string) => {
        if (id === "char-shallow-1") {
          return {
            type: "character",
            chaId: "char-shallow-1",
            name: "Fully Loaded Character",
            image: "asset-1",
            desc: "A rich detailed character description",
            personality: "Kind and curious",
            scenario: "In an ancient library",
            firstMessage: "Hello, traveler!",
            globalLore: [
              {
                key: "library",
                comment: "Ancient Library",
                content: "A massive library full of ancient scrolls",
                alwaysActive: true,
                insertorder: 0,
                secondkey: "",
                selective: false,
              },
            ],
            chats: [],
            chatPage: 0,
            detailsLoaded: true,
          } as unknown as character;
        }
        return null;
      }),
      commit: vi.fn(async () => ({ revision: 1 })),
    } as unknown as ISqlStorage;
  });

  it("hydrates character details before exporting via exportCharacterCard when detailsLoaded is false", async () => {
    const shallowChar: character = {
      type: "character",
      chaId: "char-shallow-1",
      name: "Shallow Character",
      detailsLoaded: false,
      chats: [],
      chatPage: 0,
    } as unknown as character;

    characterStore.init([shallowChar], mockStorage);

    const writer = new VirtualWriter();
    await exportCharacterCard(shallowChar, "png", { writer, spec: "v2" });

    expect(shallowChar.detailsLoaded).toBe(true);
    expect(shallowChar.desc).toBe("A rich detailed character description");
    expect(shallowChar.personality).toBe("Kind and curious");
    expect(shallowChar.firstMessage).toBe("Hello, traveler!");
    expect(shallowChar.globalLore).toHaveLength(1);
  });

  it("hydrates character details before exporting via exportChar", async () => {
    const shallowChar: character = {
      type: "character",
      chaId: "char-shallow-1",
      name: "Shallow Character",
      detailsLoaded: false,
      chats: [],
      chatPage: 0,
    } as unknown as character;

    characterStore.init([shallowChar], mockStorage);
    alertCardExportMock.mockResolvedValue({ type: "ccv2" });

    await exportChar(0);

    const storedChar = characterStore.characters[0] as character;
    expect(storedChar.detailsLoaded).toBe(true);
    expect(storedChar.desc).toBe("A rich detailed character description");
    expect(storedChar.personality).toBe("Kind and curious");
    expect(storedChar.firstMessage).toBe("Hello, traveler!");
  });

  it("aborts exportCharacterCard when shallow hydration does not load details", async () => {
    const shallowChar: character = {
      type: "character",
      chaId: "char-missing",
      name: "Missing Character",
      detailsLoaded: false,
      chats: [],
      chatPage: 0,
    } as unknown as character;
    characterStore.init([shallowChar], mockStorage);

    const writer = new VirtualWriter();
    await expect(
      exportCharacterCard(shallowChar, "png", { writer, spec: "v2" }),
    ).rejects.toThrow(
      "Failed to hydrate character before export: char-missing",
    );
  });

  it("aborts exportChar before prompting when shallow hydration fails", async () => {
    const shallowChar: character = {
      type: "character",
      chaId: "char-missing",
      name: "Missing Character",
      detailsLoaded: false,
      chats: [],
      chatPage: 0,
    } as unknown as character;
    characterStore.init([shallowChar], mockStorage);

    await expect(exportChar(0)).rejects.toThrow(
      "Failed to hydrate character before export: char-missing",
    );
    expect(alertCardExportMock).not.toHaveBeenCalled();
  });
});
