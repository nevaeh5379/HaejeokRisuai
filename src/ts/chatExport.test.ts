import { describe, expect, it } from "vitest";
import { buildChatJsonExportData } from "./chatExport";
import type { Chat } from "./storage/database/schema";
import type { SqlChatBranchGraphData } from "./storage/sql/ISqlStorage";

const chat = {
  id: "chat-export",
  name: "Export",
  note: "",
  localLore: [],
  message: [
    { chatId: "m1", role: "user", data: "prompt" },
    { chatId: "alt", role: "char", data: "active alternative" },
  ],
  activeBranchId: "alt-branch",
  branchState: {
    baseMessageIndex: 0,
    activeBranchId: "stale",
    branches: [],
  },
} satisfies Chat;

const graph: SqlChatBranchGraphData = {
  branches: [
    {
      id: "root",
      chatId: "chat-export",
      headMessageId: "original",
      reason: "root",
      createdAt: 1,
    },
    {
      id: "alt-branch",
      chatId: "chat-export",
      parentBranchId: "root",
      forkMessageId: "m1",
      headMessageId: "alt",
      reason: "reroll",
      createdAt: 2,
    },
  ],
  activeBranchId: "alt-branch",
  messages: [
    { chatId: "m1", role: "user", data: "prompt" },
    { chatId: "original", role: "char", data: "original response" },
    { chatId: "alt", role: "char", data: "active alternative" },
  ],
  links: [
    { messageId: "m1", originBranchId: "root" },
    { messageId: "original", parentMessageId: "m1", originBranchId: "root" },
    { messageId: "alt", parentMessageId: "m1", originBranchId: "alt-branch" },
  ],
};

describe("chat JSON export modes", () => {
  it("strips Haejeok branch metadata from compatibility JSON", () => {
    const exported = buildChatJsonExportData(chat, "compatible");
    expect(exported.message.map((message) => message.data)).toEqual([
      "prompt",
      "active alternative",
    ]);
    expect(exported.branchState).toBeUndefined();
    expect(exported.activeBranchId).toBeUndefined();
    expect(chat.branchState).toBeDefined();
  });

  it("materializes every persistent branch for Haejeok JSON", () => {
    const exported = buildChatJsonExportData(chat, "native", graph);
    expect(exported.branchState?.activeBranchId).toBe("alt-branch");
    expect(exported.branchState?.branches).toHaveLength(2);
    expect(exported.branchState?.branches[0].messages[0].data).toBe(
      "original response",
    );
    expect(exported.branchState?.branches[1].messages[0].data).toBe(
      "active alternative",
    );
  });
});
