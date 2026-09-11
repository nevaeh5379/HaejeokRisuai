import { describe, expect, it, vi } from "vitest";
import {
  buildSqliteSettingRowsQuery,
  getSqliteStorageSyncSummary,
  loadSqliteStartupProjection,
  SQLITE_STARTUP_SETTING_TEXT_LIMIT,
} from "@risuai/storage-sqlite/sqliteStartupQueries";
import type {
  SqliteSelectRowSets,
  SqliteSelectRows,
} from "@risuai/storage-sqlite/sqliteAdminQueries";

function scalarSetting(key: string, value: string, oversized = false) {
  return {
    setting_key: key,
    setting_value_type: "string",
    setting_text_value: value,
    setting_encoded_text_value: null,
    node_id: null,
    startup_oversized: oversized ? 1 : 0,
  };
}

describe("SQLite startup queries", () => {
  it("builds a bounded shallow setting projection", () => {
    const query = buildSqliteSettingRowsQuery(["large"], true);
    expect(query.bind).toEqual(["large"]);
    expect(query.sql).toContain(`> ${SQLITE_STARTUP_SETTING_TEXT_LIMIT}`);
    expect(query.sql).toContain("startup_oversized");
  });

  it("shares startup projection semantics across SQLite backends", async () => {
    const selectRowSets = vi.fn(async () => [
      [
        scalarSetting("theme", "dark"),
        scalarSetting("huge", "ignored", true),
        scalarSetting("domain-owned", "skip"),
      ],
      [
        {
          id: "char-1",
          kind: "character",
          name: "Character",
          image: "assets/avatar.png",
          trash_time: null,
          creation_time: 10,
          modification_time: 20,
          last_interaction_time: 30,
        },
      ],
      [{ initialized: 1 }],
    ]) as unknown as SqliteSelectRowSets;

    const projection = await loadSqliteStartupProjection(
      selectRowSets,
      7,
      ["lazy"],
      ["domain-owned"],
    );
    expect(projection.status).toBe("ready");
    expect(projection.revision).toBe(7);
    expect(projection.settings).toEqual(new Map([["theme", "dark"]]));
    expect(projection.deferredSettingKeys.sort()).toEqual(["huge", "lazy"]);
    expect(projection.characters).toEqual([
      {
        id: "char-1",
        kind: "character",
        name: "Character",
        image: "assets/avatar.png",
        trashTime: undefined,
        creationDate: 10,
        modificationDate: 20,
        lastInteraction: 30,
      },
    ]);
  });

  it("normalizes storage sync metadata counts", async () => {
    const selectRows = vi.fn(async () => [
      {
        revision: 9,
        initialized: 1,
        settings_count: 3,
        characters_count: 2,
        chats_count: 5,
        messages_count: 11,
      },
    ]) as unknown as SqliteSelectRows;

    await expect(getSqliteStorageSyncSummary(selectRows, 1)).resolves.toEqual({
      revision: 9,
      initialized: true,
      records: {
        settings: 3,
        characters: 2,
        chats: 5,
        messages: 11,
        total: 21,
      },
    });
  });
});
