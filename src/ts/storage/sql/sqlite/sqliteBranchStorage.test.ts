import { describe, expect, it } from "vitest";
import { buildSqliteLegacyBranchMigrationStatements } from "./sqliteBranchStorage";
import type { LegacyBranchMigrationPlan } from "../../../../../packages/protocol/legacyBranchMigration.cjs";

describe("SQLite legacy branch migration", () => {
  it("removes branchState from chat extension data after migration", () => {
    const plan: LegacyBranchMigrationPlan = {
      chatId: "chat-1",
      activeBranchId: "root",
      branches: [
        {
          id: "root",
          reason: "root",
          createdAt: 0,
          headMessageId: "m1",
        },
        {
          id: "alt",
          parentBranchId: "root",
          forkMessageId: "m1",
          headMessageId: "m1",
          reason: "reroll",
          createdAt: 1,
        },
      ],
      messages: [],
      links: [],
    };
    const statements = buildSqliteLegacyBranchMigrationStatements(
      "chat-1",
      { branchState: { branches: [{ id: "legacy" }] }, note: "keep" },
      plan,
    );
    expect(
      statements.some(({ sql }) =>
        sql.includes("DELETE FROM chat_extension_nodes WHERE chat_id = ?"),
      ),
    ).toBe(true);
    const serializedBinds = JSON.stringify(
      statements.flatMap(({ bind }) => bind),
    );
    expect(serializedBinds).toContain("note");
    expect(serializedBinds).toContain("keep");
    expect(serializedBinds).not.toContain("branchState");
  });
});
