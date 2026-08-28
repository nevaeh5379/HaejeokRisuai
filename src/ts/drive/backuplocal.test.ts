import { BaseDirectory, mkdir } from "@tauri-apps/plugin-fs";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../storage/schema";
import {
  createNativeImportSource,
  ensureTauriBackupAssetsDirectory,
  normalizeLocalBackupAssetPath,
  restoreInlayBackupEntry,
} from "./backuplocal";

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
  });

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

    const result = await restoreInlayBackupEntry("broken", new Uint8Array([1]), {
      decode: () => {
        throw decodeError;
      },
      write,
    });

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
      await import("../storage/databaseDefaults");
    const db = {
      pluginCustomStorage: { pm_store: { version: 5 } },
    } as unknown as Database;

    normalizeDatabaseDefaults(db);

    expect(db.pluginCustomStorage).toEqual({ pm_store: { version: 5 } });
  });

  it("initializes module folders without replacing existing folders", async () => {
    const { normalizeDatabaseDefaults } =
      await import("../storage/databaseDefaults");
    const emptyDb = {} as Database;
    normalizeDatabaseDefaults(emptyDb);
    expect(emptyDb.moduleFolders).toEqual([]);

    const existingDb = {
      moduleFolders: [{ id: "f1", name: "Folder 1", color: "" }],
    } as unknown as Database;
    normalizeDatabaseDefaults(existingDb);
    expect(existingDb.moduleFolders).toEqual([
      { id: "f1", name: "Folder 1", color: "" },
    ]);
  });

  it("migrates legacy Ollama models to independent auxiliary defaults", async () => {
    const { normalizeDatabaseDefaults } =
      await import("../storage/databaseDefaults");
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
      await import("../storage/databaseDefaults");
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
});
