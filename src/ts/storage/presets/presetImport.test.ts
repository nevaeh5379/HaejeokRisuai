import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encode as encodeMsgpack } from "msgpackr/index-no-eval";
import * as fflate from "fflate";
import { encodeRPack } from "../../rpack/rpack_js";
import { encryptBuffer } from "../../util";

// mock heavy util pieces before importing presetService
vi.mock("../../util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../util")>();
  return {
    ...actual,
    selectSingleFile: vi.fn(),
  };
});

import { importPreset } from "./presetService";
import { presetStore } from "../../stores/domain/presetStore.svelte";
import { setSqlStorageForTesting } from "../../storage/sql/sqlStorageFactory";
import type { ISqlStorage } from "../../storage/sql/ISqlStorage";

class MockSqlStorage {
  backendKind = "web-sqlite" as const;
  revision = 1;
  presets: any[] = [{ id: "preset-default", name: "Default", image: "" }];
  async commit(c: any): Promise<any> {
    this.revision += 1;
    if (c?.presets?.upserts) {
      for (const upsert of c.presets.upserts) {
        const existing = this.presets.findIndex((p) => p.id === upsert.id);
        const row = { ...upsert.data, id: upsert.id };
        if (existing >= 0) this.presets[existing] = row;
        else this.presets.push(row);
      }
    }
    return { revision: this.revision };
  }
  getRevision(): number {
    return this.revision;
  }
  isEnabled(): boolean {
    return true;
  }
  async close(): Promise<void> {}
  async replaceDatabase(): Promise<boolean> {
    return true;
  }
  async loadSettingKey(): Promise<undefined> {
    return undefined;
  }
  async listBotPresets(): Promise<any[]> {
    return this.presets.map((p) => ({
      id: p.id,
      name: p.name,
      image: p.image,
    }));
  }
  async loadBotPreset(id: string): Promise<any> {
    return this.presets.find((p) => p.id === id) ?? null;
  }
}

async function createRisupPreset(presetData: Record<string, unknown>) {
  const buf = fflate.compressSync(
    encodeMsgpack({
      presetVersion: 2,
      type: "preset",
      preset: await encryptBuffer(encodeMsgpack(presetData), "risupreset"),
    }),
  );
  return await encodeRPack(buf);
}

async function selectFileForImport(name: string, data: Uint8Array) {
  const { selectSingleFile } = await import("../../util");
  (selectSingleFile as any).mockResolvedValue({ name, data });
}

describe("importPreset risup flow", () => {
  beforeEach(async () => {
    presetStore.resetForTesting();
    const mockStorage = new MockSqlStorage();
    setSqlStorageForTesting(mockStorage as unknown as ISqlStorage);
    await presetStore.init(mockStorage as unknown as ISqlStorage);
    const fs = await import("node:fs");
    const mapData = fs.readFileSync("src/ts/rpack/rpack_map.bin");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            mapData.buffer.slice(
              mapData.byteOffset,
              mapData.byteOffset + mapData.byteLength,
            ),
          ),
      ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports a .risup preset file", async () => {
    const risupData = await createRisupPreset({
      name: "Test Preset",
      mainPrompt: "hello world",
      temperature: 80,
    });

    await selectFileForImport("Test Preset_preset.risup", risupData);

    await importPreset();

    expect(presetStore.summaries.length).toBe(2);
    expect(presetStore.summaries[1].name).toBe("Test Preset");
  });

  it("imports a .risup preset file with an upper-case extension", async () => {
    const risupData = await createRisupPreset({
      name: "Upper Preset",
      mainPrompt: "hello world",
    });

    await selectFileForImport("Upper Preset_preset.RISUP", risupData);

    await importPreset();

    expect(presetStore.summaries.length).toBe(2);
    expect(presetStore.summaries[1].name).toBe("Upper Preset");
  });

  it("sniffs the contents when the file name lost its extension", async () => {
    const risupData = await createRisupPreset({
      name: "Sniffed Preset",
      mainPrompt: "hello world",
    });

    await selectFileForImport("Sniffed Preset_preset", risupData);

    await importPreset();

    expect(presetStore.summaries.length).toBe(2);
    expect(presetStore.summaries[1].name).toBe("Sniffed Preset");
  });

  it("does not add a preset when the file is corrupted", async () => {
    await selectFileForImport(
      "Broken_preset.risup",
      new Uint8Array([0, 1, 2, 3, 4, 5]),
    );

    await importPreset();

    expect(presetStore.summaries.length).toBe(1);
  });
});
