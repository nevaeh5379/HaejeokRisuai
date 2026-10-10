import { describe, expect, it, vi } from "vitest";
import * as sqlitePlugin from "@risuai/storage-sqlite/queries/plugin";
import * as nodeCodec from "@risuai/storage-sqlite/schema/codec";
import type { SqliteSelectRows } from "@risuai/storage-sqlite/types";

const record = {
  plugin_id: "plugin-id",
  position: 3,
  name: "test-plugin",
  display_name: "Test Plugin",
  api_version: "3.0",
  plugin_version: "1.2.3",
  update_url: "https://example.com/plugin.js",
  enabled: 1,
};

const metadata = {
  name: "test-plugin",
  displayName: "Test Plugin",
  arguments: { prompt: "string" as const },
  realArg: { prompt: "hello" },
  version: "3.0" as const,
  customLink: [],
  argMeta: {},
  versionOfPlugin: "1.2.3",
  updateURL: "https://example.com/plugin.js",
  enabled: true,
  allowedIPC: ["clipboard"],
};

function extensionRows() {
  return nodeCodec.flatten(metadata).map((row) => ({
    ...row,
    plugin_id: "plugin-id",
  }));
}

describe("SQLite plugin queries", () => {
  it("loads plugin metadata without reading plugin_scripts", async () => {
    const selectRowsMock = vi
      .fn()
      .mockResolvedValueOnce([record])
      .mockResolvedValueOnce(extensionRows());
    const selectRows = selectRowsMock as unknown as SqliteSelectRows;

    await expect(sqlitePlugin.loadAll(selectRows)).resolves.toEqual([
      {
        id: "plugin-id",
        position: 3,
        ...metadata,
      },
    ]);

    expect(selectRowsMock).toHaveBeenCalledTimes(2);
    expect(
      selectRowsMock.mock.calls.some(([sql]) =>
        String(sql).includes("plugin_scripts"),
      ),
    ).toBe(false);
  });

  it("filters enabled metadata at the record query", async () => {
    const selectRowsMock = vi.fn().mockResolvedValueOnce([]);
    const selectRows = selectRowsMock as unknown as SqliteSelectRows;

    await expect(
      sqlitePlugin.loadAll(selectRows, { enabledOnly: true }),
    ).resolves.toEqual([]);

    expect(String(selectRowsMock.mock.calls[0][0])).toContain(
      "WHERE enabled = 1",
    );
  });

  it("loads one plugin separately from its script", async () => {
    const metadataRows = vi
      .fn()
      .mockResolvedValueOnce([record])
      .mockResolvedValueOnce(extensionRows()) as unknown as SqliteSelectRows;

    await expect(sqlitePlugin.load(metadataRows, "plugin-id")).resolves.toEqual(
      {
        id: "plugin-id",
        position: 3,
        ...metadata,
      },
    );

    const scriptRows = vi.fn(async () => [
      { script: "console.log('plugin')" },
    ]) as unknown as SqliteSelectRows;

    await expect(
      sqlitePlugin.loadScript(scriptRows, "plugin-id"),
    ).resolves.toBe("console.log('plugin')");
  });
});
