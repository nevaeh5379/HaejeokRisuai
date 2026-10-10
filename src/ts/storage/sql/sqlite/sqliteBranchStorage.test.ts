import { describe, expect, it } from "vitest";
import * as sqliteBranch from "@risuai/storage-sqlite/queries/branch";
import type { LegacyBranchMigrationPlan } from "../../../../../packages/protocol/legacyBranchMigration.ts";

describe("SQLite legacy branch migration archival behavior", () => {
  it("does not rewrite or delete chat extension data after branch migration", () => {
    const plan: LegacyBranchMigrationPlan = {
      chatId: "chat-1",
      activeBranchId: "root",
      branches: [
        {
          id: "root",
          reason: "root",
          createdAt: 0,
          headMessageId: "m1",
          runtimeState: {},
        },
        {
          id: "alt",
          parentBranchId: "root",
          forkMessageId: "m1",
          headMessageId: "m1",
          reason: "reroll",
          createdAt: 1,
          runtimeState: {},
        },
      ],
      messages: [],
      links: [],
    };
    const statements = sqliteBranch.buildLegacyMigrationStatements(
      "chat-1",
      { branchState: { branches: [{ id: "legacy" }] }, note: "keep" },
      plan,
    );
    expect(
      statements.some(({ sql }) => sql.includes("chat_extension_nodes")),
    ).toBe(false);
  });
});
