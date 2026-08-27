import { describe, expect, it } from "vitest";
import {
  expandCharacterBranchesForCompatibility,
  expandChatBranchesForCompatibility,
} from "./backupCompatibility";
import { coldStorageHeader } from "./process/coldstorageData";
import type { Chat, character } from "./storage/schema";

function ids() {
  let index = 0;
  return () => `new-${++index}`;
}

function branchedChat(): Chat {
  return {
    id: "chat-1",
    name: "Adventure",
    note: "",
    localLore: [],
    message: [
      { chatId: "u1", role: "user", data: "Choose a road" },
      { chatId: "r1-msg", role: "char", data: "Take the river" },
    ],
    bookmarks: ["u1", "r1-msg"],
    bookmarkNames: { u1: "fork", "r1-msg": "active answer" },
    branchState: {
      baseMessageIndex: 0,
      activeBranchId: "reroll-1",
      branches: [
        {
          id: "root",
          branchMessageIndex: 0,
          branchMessageId: "u1",
          reason: "root",
          createdAt: 1,
          messages: [{ chatId: "a1", role: "char", data: "Take the mountain" }],
        },        {
          id: "manual-1",
          parentBranchId: "root",
          branchMessageIndex: 0,
          branchMessageId: "u1",
          reason: "manual",
          createdAt: 2,
          messages: [],
        },
        {
          id: "reroll-1",
          parentBranchId: "root",
          branchMessageIndex: 0,
          branchMessageId: "u1",
          reason: "reroll",
          createdAt: 3,
          messages: [{ chatId: "r1-msg", role: "char", data: "Take the river" }],
        },
      ],
    },
  };
}

describe("compatible branch backup expansion", () => {
  it("exports every timeline as an independent ordinary chat", () => {
    const source = branchedChat();
    const result = expandChatBranchesForCompatibility(source, ids());

    expect(result.chats).toHaveLength(3);
    expect(result.activeIndex).toBe(2);
    expect(result.chats.map((chat) => chat.name)).toEqual([
      "Adventure",
      "Adventure (Branch 1)",
      "Adventure (Reroll 1)",
    ]);
    expect(result.chats.map((chat) => chat.message.map((message) => message.data))).toEqual([
      ["Choose a road", "Take the mountain"],
      ["Choose a road"],
      ["Choose a road", "Take the river"],
    ]);
    expect(source.branchState).toBeDefined();
  });

  it("removes branch metadata and gives exported chats independent ids", () => {
    const result = expandChatBranchesForCompatibility(branchedChat(), ids());
    const chatIds = result.chats.map((chat) => chat.id);
    const messageIds = result.chats.flatMap((chat) =>
      chat.message.map((message) => message.chatId),
    );

    expect(new Set(chatIds).size).toBe(chatIds.length);
    expect(new Set(messageIds).size).toBe(messageIds.length);
    for (const chat of result.chats) {
      expect(chat.branchState).toBeUndefined();
      expect(chat.branch).toBeUndefined();
      expect(chat.messagesFullyLoaded).toBe(true);
    }
    expect(result.chats[2].bookmarks).toHaveLength(2);
    expect(Object.keys(result.chats[2].bookmarkNames ?? {})).toHaveLength(2);
  });

  it("points the compatible character at the exported active timeline", () => {
    const plain: Chat = {
      id: "plain",
      name: "Plain",
      note: "",
      localLore: [],
      message: [{ chatId: "plain-msg", role: "user", data: "hello" }],
    };
    const source = {
      chaId: "char-1",
      name: "Bot",
      chats: [plain, branchedChat()],
      chatPage: 1,
    } as character;

    const expanded = expandCharacterBranchesForCompatibility(source, ids());
    expect(expanded.chats).toHaveLength(4);
    expect(expanded.chatPage).toBe(3);
    expect(expanded.chats[expanded.chatPage].name).toBe("Adventure (Reroll 1)");
    expect(source.chats).toHaveLength(2);
  });

  it("materializes cold-stored chat messages before branch expansion", () => {
    const coldKey = "11111111-1111-1111-1111-111111111111";
    const source = {
      chaId: "char-cold-chat",
      name: "Bot",
      chatPage: 0,
      coldStoragedChats: [coldKey],
      chats: [{
        id: "cold-chat",
        name: "Old chat",
        note: "",
        localLore: [],
        message: [{ role: "char", data: coldStorageHeader + coldKey }],
      }],
    } as character;
    const coldValues = new Map<string, unknown>([[coldKey, {
      message: [
        { chatId: "old-u", role: "user", data: "old question" },
        { chatId: "old-a", role: "char", data: "old answer" },
      ],
      scriptstate: { route: "archive" },
      localLore: [],
    }]]);

    const expanded = expandCharacterBranchesForCompatibility(
      source,
      ids(),
      coldValues,
    );

    expect(expanded.chats[0].message.map((message) => message.data)).toEqual([
      "old question",
      "old answer",
    ]);
    expect(expanded.chats[0].scriptstate).toEqual({ route: "archive" });
    expect(expanded.coldStoragedChats).toBeUndefined();
    expect(source.chats[0].message[0].data).toBe(coldStorageHeader + coldKey);
  });

  it("restores whole cold-stored characters and their nested cold chats", () => {
    const characterKey = "22222222-2222-2222-2222-222222222222";
    const chatKey = "33333333-3333-3333-3333-333333333333";
    const stub = {
      chaId: "cold-char",
      name: "Stub",
      chatPage: 0,
      coldstorage: characterKey,
      coldStoragedChats: [chatKey],
      chats: [],
    } as unknown as character;
    const restoredCharacter = {
      chaId: "cold-char",
      name: "Restored Bot",
      chatPage: 0,
      chats: [{
        id: "nested-cold-chat",
        name: "Archived adventure",
        note: "",
        localLore: [],
        message: [{ role: "char", data: coldStorageHeader + chatKey }],
      }],
    } as character;
    const coldValues = new Map<string, unknown>([
      [characterKey, { character: restoredCharacter }],
      [chatKey, {
        message: [
          { chatId: "nested-u", role: "user", data: "remember me" },
          { chatId: "nested-a", role: "char", data: "always" },
        ],
        localLore: [],
      }],
    ]);

    const expanded = expandCharacterBranchesForCompatibility(
      stub,
      ids(),
      coldValues,
    );

    expect(expanded.name).toBe("Restored Bot");
    expect(expanded.chats[0].message.map((message) => message.data)).toEqual([
      "remember me",
      "always",
    ]);
    expect(expanded.coldstorage).toBeUndefined();
    expect(expanded.coldStoragedChats).toBeUndefined();
    expect(stub.name).toBe("Stub");
  });

});
