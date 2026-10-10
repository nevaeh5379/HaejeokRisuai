import { describe, expect, it } from "vitest";
import * as sqliteChat from "@risuai/storage-sqlite/queries/chat";

describe("sqliteChatQueries", () => {
  it("builds the canonical six-query chat load plan", () => {
    const plan = sqliteChat.buildLoadPlan("chat-1", 0);
    const statements = sqliteChat.loadStatements(plan);
    expect(statements).toHaveLength(6);
    expect(plan.chat.bind).toEqual(["chat-1"]);
    expect(plan.messages.bind).toContain(1);
    expect(plan.activeBranch.bind).toEqual(["chat-1"]);
  });

  it("normalizes message pages against the current total", () => {
    const page = sqliteChat.buildMessagePagePlan("chat-1", 5, 7, 3);
    expect(page).toMatchObject({ offset: 2, total: 7, hasMore: true });
    expect(page.statement.bind).toContain(2);
  });

  it("hydrates chat metadata without app domain types", () => {
    const chat = sqliteChat.hydrateDocument(
      {
        id: "chat-1",
        name: "A",
        note: null,
        folder_id: null,
        last_message_time: 9,
      },
      { branchState: { legacy: true }, custom: 1 },
      [{ data: "hello" }],
      3,
      "chat-1:root",
    );
    expect(chat).toMatchObject({
      id: "chat-1",
      name: "A",
      note: "",
      custom: 1,
      activeBranchId: "chat-1:root",
      messageOffset: 2,
      messageTotal: 3,
      messagesFullyLoaded: false,
      messagesLoaded: true,
      detailsLoaded: true,
    });
    expect(chat).not.toHaveProperty("branchState");
  });
});
