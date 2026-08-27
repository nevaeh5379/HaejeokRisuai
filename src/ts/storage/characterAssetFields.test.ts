import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  makeHarness,
  makeWebStorage,
  makeTauriStorage,
  makeCapacitorStorage,
} from "./sqliteTestHarness";
import { buildFullDatabase } from "./sqliteTestFixtures";
import sqliteSchemaSql from "./sqlite-schema.sql?raw";
import { CHARACTER_ASSET_FIELD_KEYS } from "./sqliteStorageUtils";
import type { ISqlStorage } from "./ISqlStorage";

type MakeStorage = (database: DatabaseSync) => ISqlStorage;

const backendFactories: { name: string; make: MakeStorage }[] = [
  { name: "WebSqliteStorage", make: makeWebStorage as MakeStorage },
  { name: "TauriSqliteStorage", make: makeTauriStorage as MakeStorage },
  { name: "CapacitorSqliteStorage", make: makeCapacitorStorage as MakeStorage },
];

describe.each(backendFactories)("$name loadCharacterAssetFields", ({ make }) => {
  it("returns exactly the asset fields of the full character tree", async () => {
    const { storage, database } = makeHarness(make, sqliteSchemaSql);
    await storage.replaceDatabase(buildFullDatabase() as any);

    const full = (await storage.loadCharacter("char-1")) as any;
    const assets = (await storage.loadCharacterAssetFields("char-1")) as any;

    for (const key of CHARACTER_ASSET_FIELD_KEYS) {
      expect(assets[key]).toEqual(full[key]);
    }
    // Non-asset fields must not leak in.
    expect(assets.chats).toBeUndefined();
    expect(assets.firstMessage).toBeUndefined();
    expect(assets.name).toBeUndefined();
    database.close();
  });

  it("reads only the character's own extension nodes", async () => {
    const { storage, database, queryLog } = makeHarness(make, sqliteSchemaSql);
    await storage.replaceDatabase(buildFullDatabase() as any);
    queryLog.clear();

    const assets = (await storage.loadCharacterAssetFields("char-1")) as any;
    expect(assets.emotionImages).toEqual([["joy", "img://joy.png"]]);
    expect(assets.image).toBe("img://alpha.png");
    expect(
      queryLog.entries.filter(
        (e) =>
          e.sql.includes("character_extension_nodes") ||
          e.sql.includes("FROM characters"),
      ).length,
    ).toBeLessThanOrEqual(2);
    database.close();
  });

  it("returns null for missing characters", async () => {
    const { storage, database } = makeHarness(make, sqliteSchemaSql);
    await storage.replaceDatabase(buildFullDatabase() as any);
    expect(await storage.loadCharacterAssetFields("missing-char")).toBeNull();
    database.close();
  });
});