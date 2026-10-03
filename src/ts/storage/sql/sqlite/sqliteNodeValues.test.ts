import { describe, expect, it, vi } from "vitest";
import * as sqliteNodes from "@risuai/storage-sqlite/queries/nodes";
import type { SqliteSelectRows } from "@risuai/storage-sqlite/types";

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
      sqliteNodes.loadValue(
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
    await expect(
      sqliteNodes.loadSettingValue(selectRows, "theme"),
    ).resolves.toBe("value");
    expect(selectRows).toHaveBeenCalledWith(
      expect.stringContaining("setting_key = ?"),
      ["theme"],
    );
  });

  it("rebuilds one relational value for each owner", () => {
    const values = sqliteNodes.groupValues(
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
