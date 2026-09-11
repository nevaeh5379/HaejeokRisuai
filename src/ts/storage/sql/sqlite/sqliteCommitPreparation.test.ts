import { describe, expect, it, vi } from "vitest";
import { createEmptySqlCommit } from "../sqlCommit";
import { flattenRelationalValue } from "@risuai/storage-sqlite/relationalNodeCodec";
import {
  prepareSqliteModuleCommit,
  validateSqlitePresetCommit,
} from "@risuai/storage-sqlite/sqliteCommitPreparation";
import type { SqliteSelectRows } from "@risuai/storage-sqlite/sqliteAdminQueries";

describe("SQLite commit preparation", () => {
  it("migrates legacy modules only when the relational table is empty", async () => {
    const commit = createEmptySqlCommit(0);
    commit.modules = {
      upserts: [{ id: "new", data: { id: "new", value: 2 } }],
      deletes: ["deleted"],
    };
    const legacy = [
      { id: "legacy", value: 1 },
      { id: "deleted", value: 0 },
    ];
    const selectRows = vi.fn(async (sql: string) => {
      if (sql.includes("COUNT(*)")) return [{ count: 0 }];
      if (sql.includes("setting_extension_nodes")) {
        return flattenRelationalValue(legacy);
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }) as unknown as SqliteSelectRows;

    await prepareSqliteModuleCommit(selectRows, commit);

    expect(commit.modules.upserts.map((entry) => entry.id)).toEqual([
      "legacy",
      "new",
    ]);
    expect(commit.modules.order).toEqual(["legacy", "new"]);
    expect(commit.root.deletes).toContain("modules");
  });

  it("leaves module commits alone once relational modules exist", async () => {
    const commit = createEmptySqlCommit(0);
    commit.modules = { upserts: [], deletes: [] };
    const selectRows = vi.fn(async () => [
      { count: 3 },
    ]) as unknown as SqliteSelectRows;

    await prepareSqliteModuleCommit(selectRows, commit);

    expect(selectRows).toHaveBeenCalledTimes(1);
    expect(commit.root.deletes).not.toContain("modules");
  });

  it("selects a surviving preset when the active preset is removed", async () => {
    const commit = createEmptySqlCommit(0);
    commit.presets = {
      upserts: [],
      deletes: ["a"],
    };
    const selectRows = vi.fn(async (sql: string) => {
      if (sql.includes("FROM bot_presets")) {
        return [{ preset_id: "a" }, { preset_id: "b" }];
      }
      if (sql.includes("setting_extension_nodes")) return [];
      throw new Error(`Unexpected SQL: ${sql}`);
    }) as unknown as SqliteSelectRows;

    await validateSqlitePresetCommit(selectRows, commit);

    expect(commit.presets.activeId).toBe("b");
  });

  it("rejects preset orders that do not contain every resulting preset", async () => {
    const commit = createEmptySqlCommit(0);
    commit.presets = { upserts: [], deletes: [], order: ["a"] };
    const selectRows = vi.fn(async () => [
      { preset_id: "a" },
      { preset_id: "b" },
    ]) as unknown as SqliteSelectRows;

    await expect(
      validateSqlitePresetCommit(selectRows, commit),
    ).rejects.toThrow("Preset order must contain every preset ID exactly once");
  });

  it("rejects commits that remove every preset", async () => {
    const commit = createEmptySqlCommit(0);
    commit.presets = { upserts: [], deletes: ["a"] };
    const selectRows = vi.fn(async () => [
      { preset_id: "a" },
    ]) as unknown as SqliteSelectRows;

    await expect(
      validateSqlitePresetCommit(selectRows, commit),
    ).rejects.toThrow("At least one bot preset must remain");
  });
});
