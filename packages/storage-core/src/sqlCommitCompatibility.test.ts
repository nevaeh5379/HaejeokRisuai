import { describe, expect, it } from "vitest";
import { mergeLegacyModulesIntoCommit } from "./sqlCommitCompatibility";
import type { SqlCommit } from "@risuai/protocol/src/sqlCommit.ts";

function createEmptyCommit(): SqlCommit<object> {
  return {
    action: "upsert",
    characters: [],
    chats: [],
    messages: [],
    root: { upserts: [], deletes: [] },
    modules: { upserts: [], deletes: [] },
    plugins: { upserts: [], deletes: [] },
    persona: { upserts: [], deletes: [] },
  };
}

describe("mergeLegacyModulesIntoCommit", () => {
  it("migrates legacy modules into commit upserts and preserves order", () => {
    const commit = createEmptyCommit();
    const legacyModules = [
      { id: "mod-1", name: "Module 1" },
      { id: "mod-2", name: "Module 2" },
    ];

    mergeLegacyModulesIntoCommit(commit, legacyModules);

    expect(commit.modules?.upserts).toHaveLength(2);
    expect(commit.modules?.upserts[0]).toEqual({
      id: "mod-1",
      position: 0,
      data: { id: "mod-1", name: "Module 1" },
    });
    expect(commit.modules?.upserts[1]).toEqual({
      id: "mod-2",
      position: 1,
      data: { id: "mod-2", name: "Module 2" },
    });
    expect(commit.modules?.order).toEqual(["mod-1", "mod-2"]);
    expect(commit.root.deletes).toContain("modules");
  });

  it("skips deleted and changed modules when migrating legacy entries", () => {
    const commit = createEmptyCommit();
    commit.modules!.deletes = ["mod-1"];
    commit.modules!.upserts = [
      { id: "mod-2", position: 0, data: { id: "mod-2", name: "Updated 2" } },
    ];

    const legacyModules = [
      { id: "mod-1", name: "Old 1" },
      { id: "mod-2", name: "Old 2" },
      { id: "mod-3", name: "Module 3" },
    ];

    mergeLegacyModulesIntoCommit(commit, legacyModules);

    expect(commit.modules?.order).toEqual(["mod-2", "mod-3"]);
    // Migrated mod-3 + existing mod-2
    expect(commit.modules?.upserts).toHaveLength(2);
    expect(commit.modules?.upserts[0]).toEqual({
      id: "mod-3",
      position: 1,
      data: { id: "mod-3", name: "Module 3" },
    });
    expect(commit.modules?.upserts[1].id).toBe("mod-2");
  });

  it("handles non-array or missing module commits gracefully", () => {
    const commit = createEmptyCommit();
    delete (commit as any).modules;
    expect(() =>
      mergeLegacyModulesIntoCommit(commit, [{ id: "mod-1" }]),
    ).not.toThrow();

    const commit2 = createEmptyCommit();
    expect(() => mergeLegacyModulesIntoCommit(commit2, null)).not.toThrow();
  });
});
