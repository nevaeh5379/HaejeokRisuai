import { describe, expect, it } from "vitest";
import { findRerollAlternatives, resolveRerollTarget } from "./chatReroll";
import type { Message } from "./storage/database/schema";
import type { SqlChatBranchSummary } from "./storage/sql/ISqlStorage";

describe("findRerollAlternatives", () => {
  const branch = (
    id: string,
    createdAt: number,
    extra: Partial<SqlChatBranchSummary> = {},
  ): SqlChatBranchSummary => ({
    id,
    chatId: "chat",
    reason: "reroll",
    parentBranchId: "root",
    forkMessageId: "u1",
    createdAt,
    ...extra,
  });
  const branches = [
    branch("root", 0, { reason: "root", parentBranchId: undefined, forkMessageId: undefined }),
    branch("r3", 3),
    branch("r1", 1),
    branch("r2", 2),
    branch("other", 4, { forkMessageId: "u2" }),
  ];

  it("reports the position of the active reroll among its siblings", () => {
    expect(findRerollAlternatives(branches, "r2", "u1")).toEqual({
      parentBranchId: "root",
      branchIds: ["root", "r1", "r2", "r3"],
      currentIndex: 2,
    });
  });

  it("counts the original reply as the first alternative", () => {
    expect(findRerollAlternatives(branches, undefined, "u1")).toMatchObject({
      branchIds: ["root", "r1", "r2", "r3"],
      currentIndex: 0,
    });
  });

  it("returns null when the active branch is unknown", () => {
    expect(findRerollAlternatives(branches, "missing", "u1")).toBeNull();
  });
});

const message = (role: Message["role"], data: string): Message => ({
  role,
  data,
});

describe("resolveRerollTarget", () => {
  it("targets the user prompt before a selected assistant response", () => {
    const messages = [
      message("user", "u1"),
      message("char", "a1"),
      message("user", "u2"),
      message("char", "a2"),
    ];
    expect(resolveRerollTarget(messages, 3)).toEqual({
      branchMessageIndex: 2,
      responseMessageIndex: 3,
    });
  });

  it("finds the first non-comment response after a selected user prompt", () => {
    const messages = [
      message("user", "u1"),
      { ...message("char", "comment"), isComment: true },
      message("char", "a1"),
    ];
    expect(resolveRerollTarget(messages, 0)).toEqual({
      branchMessageIndex: 0,
      responseMessageIndex: 2,
    });
  });

  it("allows rerolling a prompt that has no response yet", () => {
    expect(resolveRerollTarget([message("user", "u1")])).toEqual({
      branchMessageIndex: 0,
      responseMessageIndex: null,
    });
  });
});
