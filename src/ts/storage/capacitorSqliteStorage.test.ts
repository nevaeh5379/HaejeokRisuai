import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { makeCapacitorStorage } from "./sqliteTestHarness";
import sqliteSchemaSql from "./sqlite-schema.sql?raw";
import { buildFullDatabase } from "./sqliteTestFixtures";

describe("CapacitorSqliteStorage", () => {
  it("runs commits through the native transaction bridge with real SQL", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(sqliteSchemaSql);
    const storage = makeCapacitorStorage(database);
    const queryLog = (storage as any).__log;

    await storage.replaceDatabase(buildFullDatabase() as any);

    const revision = database
      .prepare("SELECT revision, initialized FROM system_storage_meta WHERE singleton = 1")
      .get() as { revision: number; initialized: number };
    expect(revision.revision).toBe(1);
    expect(revision.initialized).toBe(1);
    // The capacitor path batches the commit inside beginTransaction/commit.
    expect(
      queryLog.entries.some((e: any) => e.kind === "run" && e.sql === "BEGIN"),
    ).toBe(true);
    expect(
      queryLog.entries.some((e: any) => e.kind === "run" && e.sql === "COMMIT"),
    ).toBe(true);
    database.close();
  });
});