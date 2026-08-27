import { describe, expect, it } from "vitest";
import {
  activateChatBranch,
  createChatTimelineBranch,
  getChatBranchMessages,
  getRerollAlternatives,
  resolveRerollTarget,
  syncActiveChatBranch,
} from "./chatBranches";
import type { Chat, Message } from "./storage/schema";

function makeMessage(role: Message["role"], data: string, chatId: string): Message {
  return { role, data, chatId };
}

function makeChat(messages: Message[]): Chat {
  return {
    id: "chat-1",
    name: "Session",
    note: "",
    localLore: [],
    message: messages,
  };
}

function data(chat: Chat): string[] {
  return chat.message.map((message) => message.data);
}

describe("chatBranches", () => {
  it("creates a branch inside the same chat instead of creating another session", () => {
    const chat = makeChat([
      makeMessage("user", "hello", "m1"),
      makeMessage("char", "first", "m2"),
      makeMessage("user", "again", "m3"),
    ]);
    const originalId = chat.id;

    const branch = createChatTimelineBranch(chat, {
      branchMessageIndex: 1,
      branchMessageId: "m2",
      reason: "manual",
      createdAt: 100,
    });

    expect(chat.id).toBe(originalId);
    expect(data(chat)).toEqual(["hello", "first"]);
    expect(chat.branchState?.branches).toHaveLength(2);
    expect(chat.branchState?.activeBranchId).toBe(branch.id);
    expect(chat.branchState?.baseMessageIndex).toBe(1);
  });

  it("switches between saved timelines within one chat", () => {
    const chat = makeChat([
      makeMessage("user", "hello", "m1"),
      makeMessage("char", "original", "m2"),
    ]);
    const child = createChatTimelineBranch(chat, {
      branchMessageIndex: 0,
      branchMessageId: "m1",
      reason: "reroll",
      createdAt: 10,
    });
    chat.message.push(makeMessage("char", "alternative", "r1"));
    const rootId = chat.branchState!.branches.find((branch) => branch.reason === "root")!.id;

    // Switching away snapshots the live active path; normal generation does not
    // need to rewrite branch metadata on every response.
    activateChatBranch(chat, rootId);
    expect(data(chat)).toEqual(["hello", "original"]);

    activateChatBranch(chat, child.id);
    expect(data(chat)).toEqual(["hello", "alternative"]);
    expect(chat.id).toBe("chat-1");
  });

  it("treats rerolls from the same turn as sibling timelines", () => {
    const chat = makeChat([
      makeMessage("user", "hello", "m1"),
      makeMessage("char", "original", "m2"),
    ]);
    const first = createChatTimelineBranch(chat, {
      branchMessageIndex: 0,
      reason: "reroll",
      createdAt: 10,
    });
    chat.message.push(makeMessage("char", "first reroll", "r1"));
    syncActiveChatBranch(chat);
    const rootId = first.parentBranchId!;

    activateChatBranch(chat, rootId);
    const second = createChatTimelineBranch(chat, {
      parentBranchId: rootId,
      branchMessageIndex: 0,
      reason: "reroll",
      createdAt: 20,
    });
    chat.message.push(makeMessage("char", "second reroll", "r2"));
    syncActiveChatBranch(chat);

    const alternatives = getRerollAlternatives(chat, 0)!;
    expect(alternatives.parentBranchId).toBe(rootId);
    expect(alternatives.branchIds).toEqual([rootId, first.id, second.id]);
    expect(alternatives.currentIndex).toBe(2);
  });

  it("moves the shared base earlier without losing existing timelines", () => {
    const chat = makeChat([
      makeMessage("user", "u1", "m1"),
      makeMessage("char", "a1", "m2"),
      makeMessage("user", "u2", "m3"),
      makeMessage("char", "a2", "m4"),
    ]);
    const laterBranch = createChatTimelineBranch(chat, {
      branchMessageIndex: 2,
      reason: "manual",
      createdAt: 10,
    });
    chat.message.push(makeMessage("char", "alternate a2", "r1"));
    syncActiveChatBranch(chat);
    const rootId = laterBranch.parentBranchId!;
    activateChatBranch(chat, rootId);

    createChatTimelineBranch(chat, {
      branchMessageIndex: 0,
      reason: "manual",
      createdAt: 20,
    });

    expect(chat.branchState?.baseMessageIndex).toBe(0);
    expect(getChatBranchMessages(chat, rootId).map((message) => message.data)).toEqual([
      "u1", "a1", "u2", "a2",
    ]);
    expect(getChatBranchMessages(chat, laterBranch.id).map((message) => message.data)).toEqual([
      "u1", "a1", "u2", "alternate a2",
    ]);
  });

  it("stores only the branch suffix after the shared base", () => {
    const chat = makeChat([
      makeMessage("user", "u1", "m1"),
      makeMessage("char", "a1", "m2"),
    ]);
    const branch = createChatTimelineBranch(chat, {
      branchMessageIndex: 0,
      reason: "manual",
      createdAt: 10,
    });
    chat.message.push(makeMessage("char", "alt", "r1"));
    chat.message.push(makeMessage("user", "u2", "r2"));
    syncActiveChatBranch(chat);

    expect(chat.branchState?.baseMessageIndex).toBe(0);
    expect(branch.messages.map((message) => message.data)).toEqual(["alt", "u2"]);
    expect(branch.messages.some((message) => message.chatId === "m1")).toBe(false);
  });

  it("resolves an arbitrary assistant message to the user turn it answers", () => {
    const messages = [
      makeMessage("user", "u1", "m1"),
      makeMessage("char", "a1", "m2"),
      makeMessage("user", "u2", "m3"),
      makeMessage("char", "a2", "m4"),
      makeMessage("user", "u3", "m5"),
      makeMessage("char", "a3", "m6"),
    ];

    expect(resolveRerollTarget(messages, 3)).toEqual({
      branchMessageIndex: 2,
      responseMessageIndex: 3,
    });
  });

  it("allows rerolling directly from a user message position", () => {
    const messages = [
      makeMessage("user", "u1", "m1"),
      makeMessage("char", "a1", "m2"),
      makeMessage("user", "u2", "m3"),
      makeMessage("char", "a2", "m4"),
    ];

    expect(resolveRerollTarget(messages, 2)).toEqual({
      branchMessageIndex: 2,
      responseMessageIndex: 3,
    });
  });

  it("creates a reroll below a manual branch that ends at a user message", () => {
    const chat = makeChat([
      makeMessage("user", "u1", "m1"),
      makeMessage("char", "a1", "m2"),
      makeMessage("user", "u2", "m3"),
      makeMessage("char", "a2", "m4"),
    ]);
    const manualBranch = createChatTimelineBranch(chat, {
      branchMessageIndex: 2,
      reason: "manual",
      createdAt: 10,
    });

    expect(data(chat)).toEqual(["u1", "a1", "u2"]);
    expect(resolveRerollTarget(chat.message, 2)).toEqual({
      branchMessageIndex: 2,
      responseMessageIndex: null,
    });

    const alternatives = getRerollAlternatives(chat, 2)!;
    const rerollBranch = createChatTimelineBranch(chat, {
      parentBranchId: alternatives.parentBranchId,
      branchMessageIndex: 2,
      reason: "reroll",
      createdAt: 20,
    });
    chat.message.push(makeMessage("char", "alternate a2", "r1"));
    syncActiveChatBranch(chat);

    expect(rerollBranch.parentBranchId).toBe(manualBranch.id);
    expect(data(chat)).toEqual(["u1", "a1", "u2", "alternate a2"]);
    expect(rerollBranch.messages.map((message) => message.data)).toEqual(["alternate a2"]);
  });

  it("keeps the latest-turn behavior when no reroll position is supplied", () => {
    const messages = [
      makeMessage("user", "u1", "m1"),
      makeMessage("char", "a1", "m2"),
      makeMessage("user", "u2", "m3"),
      makeMessage("char", "a2", "m4"),
    ];

    expect(resolveRerollTarget(messages)).toEqual({
      branchMessageIndex: 2,
      responseMessageIndex: 3,
    });
  });
});
