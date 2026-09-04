import { describe, expect, it } from "vitest";
import {
  materializePortableBranchChat,
  materializePortableDatabaseBranches,
} from "@risuai/backup-core/portableBranches.cjs";

const message = (chatId: string, data: string) => ({
  chatId,
  role: "char" as const,
  data,
});

describe("portable branch backup", () => {
  it("rebuilds all SQL branch timelines into native branchState", () => {
    const chat = {
      id: "chat-1",
      name: "test",
      note: "",
      message: [message("m1", "shared"), message("alt", "active")],
      scriptstate: { active: "yes" },
    };
    const graph = {
      branches: [
        {
          id: "root",
          chatId: "chat-1",
          headMessageId: "original",
          reason: "root" as const,
          createdAt: 1,
        },
        {
          id: "reroll",
          chatId: "chat-1",
          parentBranchId: "root",
          forkMessageId: "m1",
          headMessageId: "alt",
          reason: "reroll" as const,
          createdAt: 2,
        },
      ],
      activeBranchId: "reroll",
      messages: [
        message("m1", "shared"),
        message("original", "original"),
        message("alt", "active"),
      ],
      links: [
        { messageId: "m1", originBranchId: "root" },
        {
          messageId: "original",
          parentMessageId: "m1",
          originBranchId: "root",
        },
        { messageId: "alt", parentMessageId: "m1", originBranchId: "reroll" },
      ],
    };

    const portable = materializePortableBranchChat(chat, graph);

    expect(portable.message.map((item: any) => item.data)).toEqual([
      "shared",
      "active",
    ]);
    expect(portable.branchState?.baseMessageIndex).toBe(0);
    expect(portable.branchState?.activeBranchId).toBe("reroll");
    expect(portable.branchState?.branches).toHaveLength(2);
    expect(
      portable.branchState?.branches[0].messages.map((item: any) => item.data),
    ).toEqual(["original"]);
    expect(portable.branchState?.branches[1]).toMatchObject({
      id: "reroll",
      parentBranchId: "root",
      branchMessageId: "m1",
      messages: [expect.objectContaining({ data: "active" })],
      scriptstate: { active: "yes" },
    });
  });

  it("hydrates every chat in a database snapshot through the persistent graph loader", async () => {
    const database = {
      characters: [
        {
          chats: [
            {
              id: "chat-db",
              message: [message("m1", "shared"), message("alt", "active")],
            },
          ],
        },
      ],
    };
    const loaderCalls: string[] = [];
    const portable = await materializePortableDatabaseBranches(
      database,
      async (chatId: string) => {
        loaderCalls.push(chatId);
        return {
          branches: [
            {
              id: "root",
              chatId,
              headMessageId: "root-tail",
              reason: "root",
              createdAt: 1,
            },
            {
              id: "alt",
              chatId,
              parentBranchId: "root",
              forkMessageId: "m1",
              headMessageId: "alt",
              reason: "reroll",
              createdAt: 2,
            },
          ],
          activeBranchId: "alt",
          messages: [
            message("m1", "shared"),
            message("root-tail", "root"),
            message("alt", "active"),
          ],
          links: [
            { messageId: "m1", originBranchId: "root" },
            {
              messageId: "root-tail",
              parentMessageId: "m1",
              originBranchId: "root",
            },
            { messageId: "alt", parentMessageId: "m1", originBranchId: "alt" },
          ],
        };
      },
    );

    expect(loaderCalls).toEqual(["chat-db"]);
    expect(
      (portable.characters[0].chats[0] as any).branchState.branches,
    ).toHaveLength(2);
    expect(
      (database.characters[0].chats[0] as any).branchState,
    ).toBeUndefined();
  });

  it("keeps an empty child branch as a real timeline", () => {
    const chat = { id: "chat-2", message: [message("m1", "shared")] };
    const graph = {
      branches: [
        {
          id: "root",
          chatId: "chat-2",
          headMessageId: "m2",
          reason: "root" as const,
          createdAt: 1,
        },
        {
          id: "empty",
          chatId: "chat-2",
          parentBranchId: "root",
          forkMessageId: "m1",
          headMessageId: "m1",
          reason: "manual" as const,
          createdAt: 2,
        },
      ],
      activeBranchId: "empty",
      messages: [message("m1", "shared"), message("m2", "root tail")],
      links: [
        { messageId: "m1", originBranchId: "root" },
        { messageId: "m2", parentMessageId: "m1", originBranchId: "root" },
      ],
    };

    const portable = materializePortableBranchChat(chat, graph);
    expect(portable.branchState?.baseMessageIndex).toBe(0);
    expect(
      portable.branchState?.branches.find(
        (branch: any) => branch.id === "empty",
      )?.messages,
    ).toEqual([]);
  });
});
