import { describe, expect, it, vi } from "vitest";
import {
  listSqliteBotPresets,
  loadSqliteBotPreset,
  loadSqliteModules,
  loadSqlitePrompts,
  loadSqliteSettingValues,
} from "@risuai/storage-sqlite/sqliteDocumentQueries";
import type { SqliteSelectRows } from "@risuai/storage-sqlite/sqliteAdminQueries";
import { flattenRelationalValue } from "@risuai/storage-sqlite/relationalNodeCodec";

function valueNode(owner: string, value: string, ownerKey = "setting_key") {
  return {
    [ownerKey]: owner,
    node_id: 0,
    parent_node_id: null,
    node_order: 0,
    object_key: null,
    object_key_encoded: null,
    value_type: "string",
    text_value: value,
    encoded_text_value: null,
    number_value: null,
    boolean_value: null,
  };
}

describe("SQLite document queries", () => {
  it("loads several settings in one relational query", async () => {
    const selectRows = vi.fn(async () => [
      valueNode("a", "A"),
      valueNode("b", "B"),
    ]) as unknown as SqliteSelectRows;
    await expect(
      loadSqliteSettingValues(selectRows, ["a", "b", "c"]),
    ).resolves.toEqual(
      new Map([
        ["a", "A"],
        ["b", "B"],
        ["c", undefined],
      ]),
    );
  });

  it("maps preset summaries and restores the preset id", async () => {
    const summaryRows = vi.fn(async () => [
      {
        preset_id: "preset-a",
        position: 2,
        name: "A",
        image: "asset",
        api_type: "openai",
        ai_model: "model",
        content_hash: "hash",
      },
    ]) as unknown as SqliteSelectRows;
    await expect(listSqliteBotPresets(summaryRows)).resolves.toEqual([
      {
        id: "preset-a",
        position: 2,
        name: "A",
        image: "asset",
        apiType: "openai",
        aiModel: "model",
        hash: "hash",
      },
    ]);

    const presetRows = vi.fn(async () => [
      { data: JSON.stringify({ name: "Preset" }) },
    ]) as unknown as SqliteSelectRows;
    await expect(
      loadSqliteBotPreset<{ name: string }>(presetRows, "preset-a"),
    ).resolves.toEqual({ id: "preset-a", name: "Preset" });
  });

  it("rebuilds module records without app-specific module types", async () => {
    const moduleRows = flattenRelationalValue({ name: "Module" }).map(
      (row) => ({
        ...row,
        module_id: "module-a",
      }),
    );
    const selectRows = vi
      .fn()
      .mockResolvedValueOnce([{ module_id: "module-a" }])
      .mockResolvedValueOnce(moduleRows) as unknown as SqliteSelectRows;
    await expect(
      loadSqliteModules<{ name: string }>(selectRows),
    ).resolves.toEqual([{ id: "module-a", name: "Module" }]);
  });

  it("loads prompt-domain values through the shared node mapper", async () => {
    const selectRows = vi
      .fn()
      .mockResolvedValueOnce([{ key: "main" }])
      .mockResolvedValueOnce([
        valueNode("main", "prompt"),
      ]) as unknown as SqliteSelectRows;
    await expect(loadSqlitePrompts(selectRows)).resolves.toEqual({
      main: "prompt",
    });
  });
});
