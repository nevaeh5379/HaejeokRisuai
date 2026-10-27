import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encode } from "msgpackr/index-no-eval";
import * as fflate from "fflate";
import { importPreset, downloadPreset, copyPreset } from "./presetService";
import { presetStore } from "../../stores/domain/presetStore.svelte";
import { createPresetSettings } from "@risuai/protocol/domain/presetSchema.ts";
import type {
  ISqlStorage,
  StoredBotPreset,
} from "@risuai/storage-core/sqlStorage";
import type { SqlCommit } from "../sql/sqlCommit";
import { downloadFile } from "../../globalApi.svelte";
import { repairLegacyModuleIntegration } from "./legacyPresetMigration";

vi.mock("../../stores/domain/settingsStore.svelte", () => ({
  settingsStore: { state: {} },
}));
vi.mock("../../globalApi.svelte", () => ({ downloadFile: vi.fn() }));
vi.mock("../../alert", () => ({ alertNormal: vi.fn() }));
vi.mock("../../../lang", () => ({ language: { successExport: "Exported" } }));
vi.mock("../../util", async () => {
  const { webcrypto } = await import("node:crypto");
  async function crypt(
    data: Uint8Array,
    password: string,
    mode: "encrypt" | "decrypt",
  ) {
    const hash = await webcrypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(password),
    );
    const key = await webcrypto.subtle.importKey(
      "raw",
      hash,
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    return webcrypto.subtle[mode](
      { name: "AES-GCM", iv: new Uint8Array(12) },
      key,
      new Uint8Array(data).buffer,
    );
  }
  return {
    selectSingleFile: vi.fn(),
    encryptBuffer: (data, password) => crypt(data, password, "encrypt"),
    decryptBuffer: (data, password) => crypt(data, password, "decrypt"),
  };
});

describe("preset documents and file boundaries", () => {
  let storage: ISqlStorage;
  let documents: Map<string, StoredBotPreset>;
  beforeEach(async () => {
    presetStore.resetForTesting();
    documents = new Map([
      [
        "one",
        {
          ...createPresetSettings(),
          id: "one",
          name: "Original",
          image: "image.png",
        },
      ],
    ]);
    storage = {
      getRevision: () => 0,
      listBotPresets: vi.fn(async () =>
        [...documents.values()].map(({ id, name, image }) => ({
          id,
          name,
          image,
        })),
      ),
      loadSettingKey: vi.fn(async () => "one"),
      loadBotPreset: vi.fn(async (id) => structuredClone(documents.get(id))),
      commit: vi.fn(async (commit: SqlCommit) => {
        for (const entry of commit.presets?.upserts ?? [])
          documents.set(entry.id, { ...entry.data, id: entry.id });
        return { revision: 1 };
      }),
    } as unknown as ISqlStorage;
    const map = await readFile(`${process.cwd()}/src/ts/rpack/rpack_map.bin`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        arrayBuffer: async () =>
          map.buffer.slice(map.byteOffset, map.byteOffset + map.byteLength),
      })),
    );
    await presetStore.init(storage);
  });
  afterEach(() => {
    presetStore.resetForTesting();
    vi.unstubAllGlobals();
  });

  it("copies the live preset into an independent document", async () => {
    presetStore.state.mainPrompt = "live";
    presetStore.state.autoSuggestPrefix = "prefix";
    await copyPreset(0);
    expect(documents.size).toBe(2);
    const copy = [...documents.values()].find((item) => item.id !== "one");
    expect(copy).toMatchObject({
      name: "Original Copy",
      mainPrompt: "live",
      autoSuggestPrefix: "prefix",
    });
    expect(copy.id).not.toBe("one");
  });

  it("imports a legacy JSON preset with the stored field names and normalized roles", async () => {
    await importPreset({
      name: "old.json",
      data: new TextEncoder().encode(
        JSON.stringify({
          name: "Old",
          NAISettings: { topP: 0.4 },
          regex: [{ in: "a", out: "b" }],
          reasonEffort: 2,
          promptTemplate: [{ type: "plain", role: "assistant" }],
          autoSuggestPrefix: "prefix",
          autoSuggestClean: false,
        }),
      ),
    });
    const imported = [...documents.values()].find((item) => item.id !== "one");
    expect(imported).toMatchObject({
      name: "Old",
      NAISettings: { topP: 0.4, cfg_scale: 1 },
      regex: [{ in: "a", out: "b" }],
      reasonEffort: 2,
      promptTemplate: [{ role: "bot" }],
      autoSuggestPrefix: "prefix",
      autoSuggestClean: false,
    });
  });

  it("exports JSON with canonical preset names and scrubbed credentials", async () => {
    presetStore.state.reasonEffort = 4;
    presetStore.state.proxyKey = "private";
    const exported = await downloadPreset(0, "json");
    const [name, bytes] = vi.mocked(downloadFile).mock.lastCall;
    expect(name).toBe("Original_preset.json");
    const data = JSON.parse(Buffer.from(bytes as Uint8Array).toString("utf8"));
    expect(data).toMatchObject({
      reasonEffort: 4,
      proxyKey: "",
      NAISettings: { cfg_scale: 1 },
      regex: [],
    });
    expect(data).not.toHaveProperty("reasoningEffort");
    expect(exported.buf).toBeNull();
  });

  it("round-trips encrypted RPack presets and removes credentials only from the export", async () => {
    presetStore.state.mainPrompt = "exported";
    presetStore.state.proxyKey = "secret";
    presetStore.state.forceReplaceUrl = "https://private.example";
    presetStore.state.autoSuggestPrefix = "prefix";
    presetStore.state.autoSuggestClean = false;
    const exported = await downloadPreset(0, "return");
    expect(exported.data).toMatchObject({
      proxyKey: "",
      forceReplaceUrl: "",
      openAIKey: "",
      forceReplaceUrl2: "",
      textgenWebUIStreamURL: "",
      textgenWebUIBlockingURL: "",
    });
    expect(exported.data).not.toHaveProperty("id");
    expect(presetStore.state.proxyKey).toBe("secret");
    await importPreset({ name: "export.risup", data: exported.buf });
    const imported = [...documents.values()].find((item) => item.id !== "one");
    expect(imported).toMatchObject({
      mainPrompt: "exported",
      autoSuggestPrefix: "prefix",
      autoSuggestClean: false,
      proxyKey: "",
    });
  });

  it("reads the old encrypted preset envelope without RPack", async () => {
    const hash = await webcrypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("risupreset"),
    );
    const key = await webcrypto.subtle.importKey(
      "raw",
      hash,
      "AES-GCM",
      false,
      ["encrypt"],
    );
    const encrypted = await webcrypto.subtle.encrypt(
      { name: "AES-GCM", iv: new Uint8Array(12) },
      key,
      encode({ name: "Old envelope", reasonEffort: 4 }),
    );
    await importPreset({
      name: "old.risupreset",
      data: fflate.compressSync(
        encode({ type: "preset", presetVersion: 0, pres: encrypted }),
      ),
    });
    expect(
      [...documents.values()].find((item) => item.id !== "one"),
    ).toMatchObject({ name: "Old envelope", reasonEffort: 4 });
  });

  it("repairs missing module integration once without replacing an explicit empty value", async () => {
    documents.get("one").moduleIntergration = undefined;
    expect(
      await repairLegacyModuleIntegration(storage, "one", 0, "module-a"),
    ).toBe(true);
    expect(documents.get("one").moduleIntergration).toBe("module-a");
    expect(
      await repairLegacyModuleIntegration(storage, "one", 0, "module-b"),
    ).toBe(false);
    documents.get("one").moduleIntergration = "";
    expect(
      await repairLegacyModuleIntegration(storage, "one", 0, "module-b"),
    ).toBe(false);
  });
});
