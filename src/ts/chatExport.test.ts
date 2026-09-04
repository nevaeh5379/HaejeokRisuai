import { describe, expect, it } from "vitest";
import { buildChatJsonExportPayload } from "./chatExport";
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
  branchState: { baseMessageIndex: 0, activeBranchId: "stale", branches: [] },
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
  it("keeps compatibility JSON as a plain current-timeline risuChat", () => {
    const payload = buildChatJsonExportPayload(chat, "compatible", []);
    expect(payload.type).toBe("risuChat");
    expect(payload.ver).toBe(2);
    if (payload.type !== "risuChat") throw new Error("unexpected payload");
    expect(payload.data.message.map((message) => message.data)).toEqual([
      "prompt",
      "active alternative",
    ]);
    expect(payload.data.branchState).toBeUndefined();
    expect(payload.data.activeBranchId).toBeUndefined();
  });

  it("stores the persistent graph directly in Haejeok JSON", () => {
    const payload = buildChatJsonExportPayload(chat, "native", [], graph);
    expect(payload.type).toBe("haejeokChat");
    expect(payload.ver).toBe(1);
    if (payload.type !== "haejeokChat") throw new Error("unexpected payload");
    expect(payload.data.chat.branchState).toBeUndefined();
    expect(payload.data.chat.activeBranchId).toBeUndefined();
    expect(payload.data.branchGraph).toEqual(graph);
    expect(payload.data.branchGraph.branches).toHaveLength(2);
  });
});
