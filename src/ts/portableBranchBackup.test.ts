import { describe, expect, it } from "vitest";
import {
  attachPortableDatabaseBranchGraphs,
  expandChatBranchGraphForCompatibility,
  preparePortableDatabaseForBranchRestore,
} from "@risuai/backup-core/portableBranches.cjs";

const message = (chatId: string, data: string) => ({
  chatId,
  role: "char" as const,
  data,
});

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
    { messageId: "original", parentMessageId: "m1", originBranchId: "root" },
    { messageId: "alt", parentMessageId: "m1", originBranchId: "reroll" },
  ],
};

describe("portable persistent branch backup", () => {
  it("stores SQL branch graphs outside Chat without serializing branchState", async () => {
    const database = {
      characters: [
        {
          chats: [
            {
              id: "chat-1",
              message: [message("m1", "shared"), message("alt", "active")],
              activeBranchId: "reroll",
              branchState: { stale: true },
            },
          ],
        },
      ],
    };
    const portable = await attachPortableDatabaseBranchGraphs(
      database,
      async () => graph,
    );
    const chat = portable.characters[0].chats[0] as any;
    expect(chat.branchState).toBeUndefined();
    expect(chat.activeBranchId).toBeUndefined();
    expect(portable.haejeokBranchGraphs?.["chat-1"]).toEqual(graph);
    expect((database.characters[0].chats[0] as any).branchState).toBeDefined();
  });

  it("prepares the SQL root timeline for direct persistent-graph restore", async () => {
    const portable = await attachPortableDatabaseBranchGraphs(
      {
        characters: [
          {
            chats: [
              {
                id: "chat-1",
                message: [message("m1", "shared"), message("alt", "active")],
              },
            ],
          },
        ],
      },
      async () => graph,
    );
    const prepared = preparePortableDatabaseForBranchRestore(portable);
    const chat = prepared.database.characters[0].chats[0] as any;
    expect(chat.message.map((item: any) => item.data)).toEqual([
      "shared",
      "original",
    ]);
    expect(chat.branchState).toBeUndefined();
    expect((prepared.database as any).haejeokBranchGraphs).toBeUndefined();
    expect(prepared.branchGraphs["chat-1"].activeBranchId).toBe("reroll");
  });

  it("flattens a persistent graph directly for compatibility exports", () => {
    const expanded = expandChatBranchGraphForCompatibility(
      {
        id: "chat-1",
        name: "Chat",
        message: [message("m1", "shared"), message("alt", "active")],
      },
      graph,
      (() => {
        let id = 0;
        return () => `new-${++id}`;
      })(),
    );
    expect(expanded.chats).toHaveLength(2);
    expect(expanded.activeIndex).toBe(1);
    expect(
      expanded.chats.map((chat) => chat.message.map((item: any) => item.data)),
    ).toEqual([
      ["shared", "original"],
      ["shared", "active"],
    ]);
    expect(
      expanded.chats.every((chat) => (chat as any).branchState === undefined),
    ).toBe(true);
  });
  it("keeps legacy branchState only when it is needed as migration input", () => {
    const source = {
      characters: [
        {
          chats: [
            {
              id: "legacy-chat",
              message: [message("legacy-message", "legacy")],
              branchState: {
                baseMessageIndex: 0,
                activeBranchId: "legacy-root",
                branches: [
                  {
                    id: "legacy-root",
                    reason: "root",
                    createdAt: 1,
                    branchMessageIndex: 0,
                    messages: [],
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const prepared = preparePortableDatabaseForBranchRestore(source);
    expect(
      (prepared.database.characters[0].chats[0] as any).branchState,
    ).toEqual(source.characters[0].chats[0].branchState);
    expect(prepared.branchGraphs).toEqual({});
  });
});
