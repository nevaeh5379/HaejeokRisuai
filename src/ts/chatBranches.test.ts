import { describe, expect, it } from "vitest";
import {
  createChatBranch,
  getBranchFamily,
  getRerollAlternatives,
} from "./chatBranches";
import type { Chat, Message } from "./storage/database.svelte";

function makeMessage(role: Message["role"], data: string, chatId: string): Message {
  return { role, data, chatId };
}

function makeChat(id: string, messages: Message[]): Chat {
  return {
    id,
    name: "Session",
    note: "",
    localLore: [],
    message: messages,
  };
}

describe("chatBranches", () => {
  it("creates a durable branch with fresh message ids", () => {
    const source = makeChat("root", [
      makeMessage("user", "hello", "m1"),
      makeMessage("char", "first", "m2"),
      makeMessage("user", "again", "m3"),
    ]);
    source.bookmarks = ["m2", "m3"];
    source.bookmarkNames = { m2: "kept", m3: "trimmed" };
    const branch = createChatBranch(source, {
      parentChatId: "root",
      branchMessageId: "m2",
      branchMessageIndex: 1,
      reason: "manual",
      keepThroughIndex: 1,
      createdAt: 100,
    });

    expect(branch.id).not.toBe(source.id);
    expect(branch.message).toHaveLength(2);
    expect(branch.message.map((message) => message.chatId)).not.toEqual(["m1", "m2"]);
    expect(branch.message.map((message) => message.data)).toEqual(["hello", "first"]);
    expect(branch.bookmarks).toEqual([branch.message[1].chatId]);
    expect(branch.bookmarkNames).toEqual({
      [branch.message[1].chatId!]: "kept",
    });
    expect(branch.branch).toEqual({
      parentChatId: "root",
      branchMessageId: "m2",
      branchMessageIndex: 1,
      reason: "manual",
      createdAt: 100,
    });
  });

  it("treats rerolls from the same turn as ordered siblings", () => {
    const root = makeChat("root", [
      makeMessage("user", "hello", "m1"),
      makeMessage("char", "original", "m2"),
    ]);
    const first = createChatBranch(root, {
      parentChatId: "root",
      branchMessageId: "m1",
      branchMessageIndex: 0,
      reason: "reroll",
      keepThroughIndex: 0,
      createdAt: 10,
    });
    const second = createChatBranch(root, {
      parentChatId: "root",
      branchMessageId: "m1",
      branchMessageIndex: 0,
      reason: "reroll",
      keepThroughIndex: 0,
      createdAt: 20,
    });
    const chats = [root, second, first];

    const fromRoot = getRerollAlternatives(chats, root, 0);
    expect(fromRoot.chats.map((chat) => chat.id)).toEqual([
      "root",
      first.id,
      second.id,
    ]);
    expect(fromRoot.currentIndex).toBe(0);

    const fromFirst = getRerollAlternatives(chats, first, 0);
    expect(fromFirst.parentChatId).toBe("root");
    expect(fromFirst.currentIndex).toBe(1);
  });

  it("does not mix rerolls from a replaced message at the same index", () => {
    const root = makeChat("root", [makeMessage("user", "edited", "new-user")]);
    const stale = makeChat("stale", []);
    stale.branch = {
      parentChatId: "root",
      branchMessageId: "old-user",
      branchMessageIndex: 0,
      reason: "reroll",
      createdAt: 1,
    };

    const alternatives = getRerollAlternatives([root, stale], root, 0);
    expect(alternatives.chats).toEqual([root]);
  });

  it("starts a new fork when a reroll timeline advances to a later turn", () => {
    const root = makeChat("root", [
      makeMessage("user", "hello", "m1"),
      makeMessage("char", "original", "m2"),
    ]);
    const reroll = createChatBranch(root, {
      parentChatId: "root",
      branchMessageId: "m1",
      branchMessageIndex: 0,
      reason: "reroll",
      keepThroughIndex: 1,
      createdAt: 10,
    });
    reroll.message.push(makeMessage("user", "next turn", "m3"));

    const alternatives = getRerollAlternatives([root, reroll], reroll, 2);
    expect(alternatives.parentChatId).toBe(reroll.id);
    expect(alternatives.chats).toEqual([reroll]);
  });

  it("collects only descendants from the active branch family", () => {
    const root = makeChat("root", []);
    const child = makeChat("child", []);
    child.branch = {
      parentChatId: "root",
      branchMessageIndex: 0,
      reason: "manual",
      createdAt: 1,
    };
    const grandchild = makeChat("grandchild", []);
    grandchild.branch = {
      parentChatId: "child",
      branchMessageIndex: 1,
      reason: "reroll",
      createdAt: 2,
    };
    const unrelated = makeChat("other", []);

    expect(getBranchFamily([root, child, grandchild, unrelated], grandchild.id!).map((chat) => chat.id)).toEqual([
      "root",
      "child",
      "grandchild",
    ]);
  });
});
