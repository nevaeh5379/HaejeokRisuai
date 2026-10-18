import { describe, expect, it, vi } from "vitest";
import { PortableDatabaseExportWriter } from "../../../packages/backup-core/src/node/exportStream.ts";
import {
  decodeLegacyBackupDatabase,
  encodeLegacyBackupDatabase,
} from "../../../packages/backup-core/src/node/legacyFormat.ts";
import { PortableDatabaseStreamCollector } from "../../../packages/backup-core/src/stream/collector.ts";
import { iterateServerBackupPlugins } from "./portableServerPluginExport.ts";

const plugins = [
  {
    id: "plugin-enabled",
    position: 0,
    name: "Enabled plugin",
    enabled: true,
    version: "3.0",
    arguments: { endpoint: "https://example.test" },
  },
  {
    id: "plugin-disabled",
    position: 1,
    name: "Disabled plugin",
    enabled: false,
    version: "3.0",
    arguments: {},
  },
];

function makeStorage() {
  return {
    loadPlugins: vi.fn(async () => ({ plugins, hash: "metadata" })),
    loadPluginScript: vi.fn(async (id: string) =>
      id === plugins[0].id ? "// source\u0000한글" : "",
    ),
  };
}

describe("Node portable backup plugin export", () => {
  it("restores installed plugins and their separate custom storage from encoded fragments", async () => {
    const storage = makeStorage();
    const collector = new PortableDatabaseStreamCollector();
    const writer = new PortableDatabaseExportWriter({
      revision: 9,
      fragmentRecords: 1,
      encodeDatabase: encodeLegacyBackupDatabase,
      async writeEntry(_name, source) {
        const fragment = await decodeLegacyBackupDatabase(source as Uint8Array);
        collector.addFragment(fragment);
      },
    });
    await writer.emit({ type: "meta", formatVersion: 1, revision: 9 });
    for await (const record of iterateServerBackupPlugins(storage)) {
      await writer.emit(record);
    }
    await writer.emit({
      type: "plugin-storage",
      key: "Enabled plugin",
      value: { saved: "retained" },
    });
    const manifest = await writer.finalize();
    collector.setManifest(manifest);
    const restored = collector.finish();

    expect(manifest.counts.plugin).toBe(2);
    expect(restored.plugins).toEqual([
      {
        name: "Enabled plugin",
        enabled: true,
        version: "3.0",
        arguments: { endpoint: "https://example.test" },
        script: "// source\u0000한글",
      },
      {
        name: "Disabled plugin",
        enabled: false,
        version: "3.0",
        arguments: {},
        script: "",
      },
    ]);
    expect(restored.pluginCustomStorage).toEqual({
      "Enabled plugin": { saved: "retained" },
    });
  });

  it("loads the next script only when the next record is requested", async () => {
    const storage = makeStorage();
    const source = iterateServerBackupPlugins(storage);
    const first = await source.next();
    expect(first.value).toMatchObject({
      type: "plugin",
      id: "plugin-enabled",
      position: 0,
    });
    expect(storage.loadPluginScript.mock.calls).toEqual([["plugin-enabled"]]);
    const second = await source.next();
    expect(second.value).toMatchObject({
      id: "plugin-disabled",
      position: 1,
      script: "",
    });
    expect(storage.loadPluginScript.mock.calls).toEqual([
      ["plugin-enabled"],
      ["plugin-disabled"],
    ]);
    expect((await source.next()).done).toBe(true);
  });

  it("rejects a missing script instead of emitting an incomplete plugin", async () => {
    const storage = makeStorage();
    storage.loadPluginScript.mockResolvedValueOnce(null);
    await expect(iterateServerBackupPlugins(storage).next()).rejects.toThrow(
      "Backup could not load plugin script plugin-enabled",
    );
  });
});
