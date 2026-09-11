import { describe, expect, it, vi } from "vitest";
import {
  groupSqliteNodeValues,
  loadSqliteNodeValue,
  loadSqliteSettingValue,
} from "@risuai/storage-sqlite/sqliteNodeValues";
import type { SqliteSelectRows } from "@risuai/storage-sqlite/sqliteAdminQueries";

function textNode(value: string, owner?: string) {
  return {
    ...(owner ? { owner_id: owner } : {}),
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

describe("SQLite node value reader", () => {
  it("loads relational values through the shared select contract", async () => {
    const selectRows = vi.fn(async () => [
      textNode("hello"),
    ]) as unknown as SqliteSelectRows;
    await expect(
      loadSqliteNodeValue(
        selectRows,
        "setting_extension_nodes",
        "setting_key = ?",
        ["x"],
      ),
    ).resolves.toBe("hello");
    expect(selectRows).toHaveBeenCalledWith(
      expect.stringContaining(
        "FROM setting_extension_nodes WHERE setting_key = ?",
      ),
      ["x"],
    );
  });

  it("loads setting values using the canonical setting owner query", async () => {
    const selectRows = vi.fn(async () => [
      textNode("value"),
    ]) as unknown as SqliteSelectRows;
    await expect(loadSqliteSettingValue(selectRows, "theme")).resolves.toBe(
      "value",
    );
    expect(selectRows).toHaveBeenCalledWith(
      expect.stringContaining("setting_key = ?"),
      ["theme"],
    );
  });

  it("rebuilds one relational value for each owner", () => {
    const values = groupSqliteNodeValues(
      [textNode("first", "a"), textNode("second", "b")],
      "owner_id",
    );
    expect(values).toEqual(
      new Map([
        ["a", "first"],
        ["b", "second"],
      ]),
    );
  });
});
