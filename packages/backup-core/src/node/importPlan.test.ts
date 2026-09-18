import { describe, expect, it } from "vitest";
import {
  BackupImportPlanError,
  buildBackupImportPlan,
} from "./importPlan";
import type { StagedBackupContainer } from "./importStagingStore";

function staged(
  entries: StagedBackupContainer["entries"],
): StagedBackupContainer {
  return {
    entries,
    bytesRead: 100,
    ignoredExtensionEntries: 0,
  };
}

function entry(
  name: string,
  kind: StagedBackupContainer["entries"][number]["kind"],
  index: number,
) {
  return {
    index,
    name,
    kind,
    size: 1,
    filePath: `/tmp/${index}`,
  };
}

describe("buildBackupImportPlan", () => {
  it("builds a legacy import plan", () => {
    const plan = buildBackupImportPlan(
      staged([
        entry("database.risudat", "database", 0),
        entry("assets/a.png", "asset", 1),
      ]),
    );
    expect(plan.databaseMode).toBe("legacy");
    expect(plan.legacyDatabase?.name).toBe("database.risudat");
    expect(plan.assets).toHaveLength(1);
  });

  it("orders streaming fragments and requires a manifest", () => {
    const plan = buildBackupImportPlan(
      staged([
        entry("database.stream/000000000002.risudat", "databaseStream", 0),
        entry("database.stream/manifest.risudat", "databaseStream", 1),
        entry("database.stream/000000000001.risudat", "databaseStream", 2),
      ]),
    );
    expect(plan.databaseMode).toBe("stream");
    expect(plan.streamFragments.map((item) => item.name)).toEqual([
      "database.stream/000000000001.risudat",
      "database.stream/000000000002.risudat",
    ]);
  });

  it("rejects mixed legacy and streaming databases", () => {
    expect(() =>
      buildBackupImportPlan(
        staged([
          entry("database.risudat", "database", 0),
          entry("database.stream/000000000001.risudat", "databaseStream", 1),
          entry("database.stream/manifest.risudat", "databaseStream", 2),
        ]),
      ),
    ).toThrow(BackupImportPlanError);
  });

  it("rejects fragment gaps", () => {
    expect(() =>
      buildBackupImportPlan(
        staged([
          entry("database.stream/000000000002.risudat", "databaseStream", 0),
          entry("database.stream/manifest.risudat", "databaseStream", 1),
        ]),
      ),
    ).toThrow(/expected 1/i);
  });
});
