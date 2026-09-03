import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const {
  buildLegacyBranchMigrationPlan,
} = require("../../../../packages/protocol/legacyBranchMigration.cjs");

const msg = (id: string, role: "user" | "char", data: string) => ({
  chatId: id,
  role,
  data,
});

describe("legacy branch migration planner", () => {
  it("preserves reroll fork topology and inactive messages", () => {
    const chat = {
      id: "chat-1",
      message: [msg("m1", "user", "hello"), msg("r1", "char", "reroll")],
      branchState: {
        baseMessageIndex: 0,
        activeBranchId: "reroll",
        branches: [
          {
            id: "root",
            reason: "root",
            createdAt: 1,
            branchMessageIndex: 0,
            messages: [msg("m2", "char", "original")],
          },
          {
            id: "reroll",
            parentBranchId: "root",
            reason: "reroll",
            createdAt: 2,
            branchMessageId: "m1",
            branchMessageIndex: 0,
            messages: [msg("r1", "char", "reroll")],
          },
        ],
      },
    };
    let seq = 0;
    const plan = buildLegacyBranchMigrationPlan(chat, () => `new-${++seq}`);
    expect(plan.branches).toEqual([
      expect.objectContaining({
        id: "root",
        reason: "root",
        headMessageId: "m2",
      }),
      expect.objectContaining({
        id: "reroll",
        parentBranchId: "root",
        forkMessageId: "m1",
        headMessageId: "r1",
      }),
    ]);
    expect(plan.messages.map((m: any) => m.id)).toEqual(
      expect.arrayContaining(["m1", "m2", "r1"]),
    );
    expect(plan.activeBranchId).toBe("reroll");
  });

  it("derives edited-message forks from the actual common prefix", () => {
    const chat = {
      id: "chat-1",
      message: [
        msg("m1", "user", "u1"),
        msg("m2", "char", "a1"),
        msg("edit", "user", "edited"),
      ],
      branchState: {
        baseMessageIndex: 1,
        activeBranchId: "edit-branch",
        branches: [
          {
            id: "root",
            reason: "root",
            createdAt: 1,
            messages: [
              msg("m3", "user", "original"),
              msg("m4", "char", "old answer"),
            ],
          },
          {
            id: "edit-branch",
            parentBranchId: "root",
            reason: "manual",
            createdAt: 2,
            branchMessageId: "edit",
            branchMessageIndex: 2,
            messages: [msg("edit", "user", "edited")],
          },
        ],
      },
    };
    const plan = buildLegacyBranchMigrationPlan(chat, () =>
      crypto.randomUUID(),
    );
    expect(
      plan.branches.find((b: any) => b.id === "edit-branch"),
    ).toMatchObject({ forkMessageId: "m2" });
  });

  it("clones a reused message id when content or parent differs", () => {
    const chat = {
      id: "chat-1",
      message: [msg("m1", "user", "hello"), msg("same", "char", "changed")],
      branchState: {
        baseMessageIndex: 0,
        activeBranchId: "child",
        branches: [
          {
            id: "root",
            reason: "root",
            createdAt: 1,
            messages: [msg("same", "char", "original")],
          },
          {
            id: "child",
            parentBranchId: "root",
            reason: "reroll",
            createdAt: 2,
            messages: [msg("same", "char", "changed")],
          },
        ],
      },
    };
    let seq = 0;
    const plan = buildLegacyBranchMigrationPlan(chat, () => `clone-${++seq}`);
    expect(plan.messages).toHaveLength(3);
    const child = plan.branches.find((b: any) => b.id === "child");
    expect(child.headMessageId).not.toBe("same");
  });
});
