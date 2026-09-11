import { BaseDirectory, mkdir } from "@tauri-apps/plugin-fs";
import { describe, expect, it, vi } from "vitest";
import { LocalWriter } from "../globalApi.svelte";
import type { Database } from "../storage/database/schema";
import type { DatabaseInput } from "../storage/database/databaseDefaults";
import {
  createNativeImportSource,
  createNodeBackupAssetRequest,
  ensureTauriBackupAssetsDirectory,
  listBackupAssetKeys,
  normalizeLocalBackupAssetPath,
  restoreInlayBackupEntry,
  streamNodeBackupAssets,
} from "./backuplocal";

describe("LocalWriter backup entry names", () => {
  it("preserves a validated nested asset path", async () => {
    const writer = new LocalWriter();
    const chunks: Uint8Array[] = [];
    vi.spyOn(writer, "write").mockImplementation(async (chunk) => {
      chunks.push(chunk);
    });

    await writer.startBackup("assets/icon/image/2.png", 3);

    expect(new TextDecoder().decode(chunks[1])).toBe("assets/icon/image/2.png");
  });

  it("rejects unsafe backup entry paths", async () => {
    const writer = new LocalWriter();
    const write = vi.spyOn(writer, "write").mockResolvedValue();

    await expect(writer.startBackup("assets/../secret", 1)).rejects.toThrow(
      "Invalid backup entry path",
    );
    expect(write).not.toHaveBeenCalled();
  });
});

describe("createNativeImportSource", () => {
  it("pulls bounded chunks instead of assembling the native file eagerly", async () => {
    const bytes = new Uint8Array(1024 * 1024 + 17).map(
      (_, index) => index % 251,
    );
    const requests: Array<{ offset: number; length: number }> = [];
    const source = createNativeImportSource(
      {
        async readImportChunk({ offset, length }) {
          requests.push({ offset, length });
          const data = bytes.subarray(offset, offset + length);
          return {
            data: Buffer.from(data).toString("base64"),
            bytesRead: data.byteLength,
            eof: offset + data.byteLength >= bytes.byteLength,
          };
        },
      },
      "import-1",
      bytes.byteLength,
    );

    expect(requests).toEqual([]);
    const reader = source.stream().getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    expect(requests.map(({ length }) => length)).toEqual([
      512 * 1024,
      512 * 1024,
      17,
    ]);
    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))).toEqual(
      Buffer.from(bytes),
    );
  }, 15_000);

  it("rejects mismatched native chunk metadata", async () => {
    const source = createNativeImportSource(
      {
        async readImportChunk() {
          return { data: "", bytesRead: 1, eof: true };
        },
      },
      "import-2",
      1,
    );

    await expect(source.stream().getReader().read()).rejects.toThrow(
      "incomplete chunk",
    );
  });
});

describe("streamNodeBackupAssets", () => {
  it("streams remote assets into the backup and reports omitted entries", async () => {
    const first = new Uint8Array([1, 2]);
    const second = new Uint8Array([3, 4, 5]);
    const storage = {
      keys: vi.fn(),
      streamItems: vi.fn(async (keys, handlers) => {
        expect(keys).toEqual([
          "assets/first.png",
          "assets/missing.png",
          "assets/second.mp3",
        ]);
        await handlers.onFileStart("assets/first.png", 2n);
        await handlers.onFileChunk("assets/first.png", first);
        await handlers.onFileEnd?.("assets/first.png");
        await handlers.onFileStart("assets/second.mp3", 3n);
        await handlers.onFileChunk("assets/second.mp3", second);
        await handlers.onFileEnd?.("assets/second.mp3");
      }),
    };
    const entries = new Map<string, Uint8Array[]>();
    const writer = {
      startBackup: vi.fn(async (name: string) => {
        entries.set(name, []);
      }),
      write: vi.fn(async (chunk: Uint8Array) => {
        const current = [...entries.keys()].at(-1);
        if (current) entries.get(current)?.push(chunk);
      }),
    };

    const result = await streamNodeBackupAssets(storage as any, writer, [
      "assets/first.png",
      "assets/missing.png",
      "assets/second.mp3",
    ]);

    expect(result).toEqual({
      writtenKeys: ["assets/first.png", "assets/second.mp3"],
      missingKeys: ["assets/missing.png"],
    });
    expect(Buffer.concat(entries.get("assets/first.png") ?? [])).toEqual(
      Buffer.from(first),
    );
    expect(Buffer.concat(entries.get("assets/second.mp3") ?? [])).toEqual(
      Buffer.from(second),
    );
  });

  it("forwards server-side listing options to the bulk stream", async () => {
    const storage = {
      keys: vi.fn(),
      streamItems: vi.fn(async () => undefined),
    };
    const writer = {
      startBackup: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
    };

    await streamNodeBackupAssets(
      storage as any,
      writer,
      [],
      undefined,
      { prefix: "assets/" },
    );

    expect(storage.streamItems).toHaveBeenCalledWith(
      [],
      expect.any(Object),
      undefined,
      { prefix: "assets/" },
    );
  });
});

describe("createNodeBackupAssetRequest", () => {
  it("lets the server list all assets inside the bulk stream request", async () => {
    const storage = {
      keys: vi.fn(async () => ["assets/should-not-be-loaded.png"]),
    };

    await expect(
      createNodeBackupAssetRequest(storage as any, "all", new Map()),
    ).resolves.toEqual({
      keys: [],
      options: { prefix: "assets/" },
    });
    expect(storage.keys).not.toHaveBeenCalled();
  });

  it("loads and filters keys client-side for essential backups", async () => {
    const storage = {
      keys: vi.fn(async () => [
        "assets/keep.png",
        "assets/other.png",
        "assets/audio.mp3",
      ]),
    };
    const assetMap = new Map([
      ["assets/keep.png", { charName: "Character", assetName: "Main" }],
    ]);

    await expect(
      createNodeBackupAssetRequest(storage as any, "essential", assetMap),
    ).resolves.toEqual({ keys: ["assets/keep.png"] });
    expect(storage.keys).toHaveBeenCalledWith("assets/");
  });
});

describe("listBackupAssetKeys", () => {
  it("uses recursive asset listing for Tauri storage", async () => {
    const storage = {
      keys: vi.fn(async () => ["assets/root.png"]),
      listAssetKeys: vi.fn(async () => [
        "assets/nested/deep.bin",
        "assets/root.png",
      ]),
    };

    await expect(listBackupAssetKeys(storage, true)).resolves.toEqual([
      "assets/nested/deep.bin",
      "assets/root.png",
    ]);
    expect(storage.listAssetKeys).toHaveBeenCalledWith("assets/");
    expect(storage.keys).not.toHaveBeenCalled();
  });
});

describe("normalizeLocalBackupAssetPath", () => {
  it("places Tauri backup file names under the assets directory", () => {
    expect(normalizeLocalBackupAssetPath("image.png")).toBe("assets/image.png");
  });

  it("normalizes browser backup keys and Windows separators", () => {
    expect(normalizeLocalBackupAssetPath("assets/image.png")).toBe(
      "assets/image.png",
    );
    expect(normalizeLocalBackupAssetPath("assets\\nested\\image.png")).toBe(
      "assets/nested/image.png",
    );
  });

  it.each(["", "../image.png", "assets/../image.png", "/image.png"])(
    "rejects unsafe backup asset path %j",
    (name) => {
      expect(() => normalizeLocalBackupAssetPath(name)).toThrow(
        "Invalid backup asset path",
      );
    },
  );
});

describe("ensureTauriBackupAssetsDirectory", () => {
  it("creates an empty AppData assets directory before backup scanning", async () => {
    const mkdirFn = vi.fn(async () => {});

    await ensureTauriBackupAssetsDirectory(mkdirFn as typeof mkdir);

    expect(mkdirFn).toHaveBeenCalledWith("assets", {
      baseDir: BaseDirectory.AppData,
      recursive: true,
    });
  });
});

describe("restoreInlayBackupEntry", () => {
  it("classifies malformed inlay payloads without attempting a storage write", async () => {
    const decodeError = new Error("bad inlay payload");
    const write = vi.fn(async () => {});

    const result = await restoreInlayBackupEntry(
      "broken",
      new Uint8Array([1]),
      {
        decode: () => {
          throw decodeError;
        },
        write,
      },
    );

    expect(result).toEqual({ status: "invalid", error: decodeError });
    expect(write).not.toHaveBeenCalled();
  });

  it("distinguishes storage failures from invalid backup data", async () => {
    const storageError = new Error("quota exceeded");
    const asset = {
      name: "image",
      ext: "png",
      type: "image" as const,
      data: new Blob(["image"]),
    };

    const result = await restoreInlayBackupEntry("image-id", new Uint8Array(), {
      decode: () => asset,
      write: async () => {
        throw storageError;
      },
    });

    expect(result).toEqual({ status: "storage-error", error: storageError });
  });
});

describe("backup database defaults", () => {
  it("preserves plugin custom storage during normalization", async () => {
    const { normalizeDatabaseDefaults } =
      await import("../storage/database/databaseDefaults");
    const db = {
      pluginCustomStorage: { pm_store: { version: 5 } },
    } as unknown as Database;

    normalizeDatabaseDefaults(db);

    expect(db.pluginCustomStorage).toEqual({ pm_store: { version: 5 } });
  });

  it("initializes module folders without replacing existing folders", async () => {
    const { normalizeDatabaseDefaults } =
      await import("../storage/database/databaseDefaults");
    const emptyDb: DatabaseInput = {};
    const normalizedEmptyDb = normalizeDatabaseDefaults(emptyDb);
    expect(normalizedEmptyDb.moduleFolders).toEqual([]);

    const existingDb = {
      moduleFolders: [{ id: "f1", name: "Folder 1", color: "" }],
    } satisfies DatabaseInput;
    const normalizedExistingDb = normalizeDatabaseDefaults(existingDb);
    expect(normalizedExistingDb.moduleFolders).toEqual([
      { id: "f1", name: "Folder 1", color: "" },
    ]);
  });

  it("migrates legacy Ollama models to independent auxiliary defaults", async () => {
    const { normalizeDatabaseDefaults } =
      await import("../storage/database/databaseDefaults");
    const db = {
      aiModel: "ollama-cloud",
      subModel: "ollama-cloud",
      ollamaModel: "local-legacy",
      ollamaModelName: "Local Legacy",
      ollamaCloudModel: "cloud-legacy",
      ollamaCloudModelName: "Cloud Legacy",
    } as unknown as Database;

    normalizeDatabaseDefaults(db);

    expect(db.ollamaSubModel).toBe("local-legacy");
    expect(db.ollamaSubModelName).toBe("Local Legacy");
    expect(db.ollamaCloudSubModel).toBe("cloud-legacy");
    expect(db.ollamaCloudSubModelName).toBe("Cloud Legacy");
  });

  it("migrates shared provider models to independent auxiliary defaults", async () => {
    const { normalizeDatabaseDefaults } =
      await import("../storage/database/databaseDefaults");
    const db = {
      openrouterRequestModel: "openrouter-main",
      nanogptRequestModel: "nanogpt-main",
      nanogptRequestModelName: "NanoGPT Main",
      nanogptProvider: "provider-main",
      nanogptUseSubscriptionEndpoint: true,
      customProxyRequestModel: "proxy-main",
    } as unknown as Database;

    normalizeDatabaseDefaults(db);

    expect(db.openrouterSubRequestModel).toBe("openrouter-main");
    expect(db.nanogptSubRequestModel).toBe("nanogpt-main");
    expect(db.nanogptSubRequestModelName).toBe("NanoGPT Main");
    expect(db.nanogptSubProvider).toBe("provider-main");
    expect(db.nanogptSubUseSubscriptionEndpoint).toBe(true);
    expect(db.customProxySubRequestModel).toBe("proxy-main");
  });

  it("does not mutate the shared preset template when creating defaults", async () => {
    const { normalizeDatabaseDefaults } =
      await import("../storage/database/databaseDefaults");
    const { presetTemplate } =
      await import("../storage/presets/presetDefaults");
    const originalName = presetTemplate.name;
    const db: DatabaseInput = {};

    const normalizedDb = normalizeDatabaseDefaults(db);

    expect(normalizedDb.botPresets?.[0]?.name).toBe("Default");
    expect(normalizedDb.botPresets?.[0]).not.toBe(presetTemplate);
    expect(presetTemplate.name).toBe(originalName);
  });
});
