import { describe, expect, it } from "vitest";
import { resolveRerollTarget } from "./chatReroll";
import type { Message } from "./storage/database/schema";

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
