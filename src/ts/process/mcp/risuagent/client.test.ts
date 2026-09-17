import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./deps", () => ({
  defaultRisuAgentAccessDependencies: {
    resolveCharacter: vi.fn(),
    loadChatMessagePage: vi.fn(),
  },
}));

import type { Chat, Message, character } from "../../../storage/database/schema";
import { RISU_AGENT_READ_TOOL_NAMES, RisuAgentAccessClient } from "./client";
import type { RisuAgentAccessDependencies } from "./deps";

function makeMessage(id: string, role: Message["role"], data: string): Message {
  return { chatId: id, role, data, time: 1 };
}

function makeCharacter(overrides: Partial<character> = {}): character {
  const chat: Chat = {
    id: "chat-a",
    name: "Chat A",
    note: "",
    localLore: [],
    message: [],
    lastDate: 100,
  };
  return {
    chaId: "char-a",
    type: "character",
    name: "Alice",
    desc: "A test character",
    personality: "curious",
    scenario: "a lab",
    firstMessage: "hello",
    exampleMessage: "example",
    creatorNotes: "notes",
    systemPrompt: "",
    postHistoryInstructions: "",
    replaceGlobalNote: "",
    tags: ["test"],
    creator: "tester",
    characterVersion: "1.0",
    alternateGreetings: [],
    globalLore: [
      {
        key: "alice",
        secondkey: "",
        insertorder: 0,
        comment: "Alice Lore",
        content: "Alice lives in a lab.",
        mode: "normal",
        alwaysActive: false,
        selective: false,
      },
    ],
    chats: [chat],
    chatPage: 0,
    ...overrides,
  } as character;
}

function textOf(result: Awaited<ReturnType<RisuAgentAccessClient["callTool"]>>) {
  const first = result[0];
  if (!first || first.type !== "text") throw new Error("Expected text result");
  return first.text;
}

const agentContext = {
  currentChar: { chaId: "§risu-agent", name: "Risu Agent" },
  chatTarget: { characterId: "§risu-agent", chatId: "agent-chat" },
} as never;

describe("RisuAgentAccessClient", () => {
  let deps: RisuAgentAccessDependencies;
  let client: RisuAgentAccessClient;

  beforeEach(() => {
    deps = {
      resolveCharacter: vi.fn(async (id: string) =>
        id === "char-a" ? makeCharacter() : null,
      ),
      loadChatMessagePage: vi.fn(async () => ({
        messages: [],
        offset: 0,
        total: 0,
        hasMore: false,
      })),
    };
    client = new RisuAgentAccessClient(
      { characterId: "char-a", chatId: "chat-a" },
      deps,
    );
  });

  test("discovers only read-only agent tools", async () => {
    const tools = await client.getToolList();
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual([...RISU_AGENT_READ_TOOL_NAMES].sort());
    for (const name of names) {
      expect(name.startsWith("risu-agent-")).toBe(true);
      expect(name).not.toMatch(/(set|delete|create|update|write|remove)/i);
    }
  });

  test("rejects mutation tool names before touching any dependency", async () => {
    for (const name of [
      "risu-set-character-info",
      "risu-set-character-lorebook",
      "risu-delete-character-lorebook",
      "risu-set-module-lorebook",
      "risu-delete-module-regex-script",
    ]) {
      const text = textOf(await client.callTool(name, { id: "char-a" }));
      expect(text).toMatch(/not available to Risu Agent/i);
      expect(text).toMatch(/read-only/i);
    }
    expect(deps.resolveCharacter).not.toHaveBeenCalled();
    expect(deps.loadChatMessagePage).not.toHaveBeenCalled();
  });

  test("rejects reading a different character by id", async () => {
    const text = textOf(
      await client.callTool("risu-agent-get-character-info", {
        id: "char-b",
      }),
    );

    expect(text).toMatch(/scoped to the attached character/i);
  });

  test("blank/current target resolves to the attached character, not the agent", async () => {
    for (const id of [undefined, "", "current"]) {
      const text = textOf(
        await client.callTool(
          "risu-agent-get-character-info",
          { id, fields: ["name"] },
          agentContext,
        ),
      );
      const payload = JSON.parse(text);
      expect(payload.characterId).toBe("char-a");
      expect(payload.name).toBe("Alice");
    }
    expect(deps.resolveCharacter).toHaveBeenCalledWith("char-a");
    expect(deps.resolveCharacter).not.toHaveBeenCalledWith("§risu-agent");
  });

  test("paginates chat history through the bounded page loader only", async () => {
    (deps.loadChatMessagePage as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        messages: [makeMessage("m2", "user", "two"), makeMessage("m3", "char", "three")],
        offset: 1,
        total: 3,
        hasMore: true,
      })
      .mockResolvedValueOnce({
        messages: [makeMessage("m1", "user", "one")],
        offset: 0,
        total: 3,
        hasMore: false,
      });

    const first = JSON.parse(
      textOf(
        await client.callTool("risu-agent-get-chat-history", { count: 2 }),
      ),
    );
    expect(deps.loadChatMessagePage).toHaveBeenCalledWith(
      "chat-a",
      undefined,
      2,
    );
    expect(first.total).toBe(3);
    expect(first.nextBefore).toBe(1);
    expect(first.hasMore).toBe(true);
    // Newest first while keeping absolute indexes stable.
    expect(first.messages.map((m: { index: number }) => m.index)).toEqual([
      2, 1,
    ]);

    const second = JSON.parse(
      textOf(
        await client.callTool("risu-agent-get-chat-history", {
          count: 2,
          before: first.nextBefore,
        }),
      ),
    );
    expect(deps.loadChatMessagePage).toHaveBeenLastCalledWith("chat-a", 1, 2);
    expect(second.hasMore).toBe(false);
    expect(second.nextBefore).toBeNull();

    // No whole-chat loader exists on the dependency boundary.
    expect(Object.keys(deps)).toEqual([
      "resolveCharacter",
      "loadChatMessagePage",
    ]);
  });

  test("rejects reading a chat other than the attached one", async () => {
    const text = textOf(
      await client.callTool("risu-agent-get-chat-history", {
        chatId: "chat-other",
      }),
    );

    expect(text).toMatch(/only the explicitly attached chat/i);
    expect(deps.loadChatMessagePage).not.toHaveBeenCalled();
  });

  test("keeps the attached target stable across an await", async () => {
    const characters = [
      makeCharacter({ chaId: "char-a", name: "Alice" }),
      makeCharacter({ chaId: "char-b", name: "Bob" }),
    ];
    deps.resolveCharacter = vi.fn(async (id: string) => {
      // Simulate selection/order churn between the tool call and resolution.
      characters.reverse();
      return characters.find((char) => char.chaId === id) ?? null;
    });

    const text = textOf(
      await client.callTool("risu-agent-get-character-info", {
        fields: ["name"],
      }),
    );

    expect(JSON.parse(text).characterId).toBe("char-a");
    expect(JSON.parse(text).name).toBe("Alice");
  });

  test("lists lorebooks with bounded previews", async () => {
    const payload = JSON.parse(
      textOf(await client.callTool("risu-agent-list-lorebooks", {})),
    );

    expect(payload.total).toBe(1);
    expect(payload.entries[0].name).toBe("Alice Lore");
    expect(payload.entries[0].contentPreview).toBe("Alice lives in a lab.");
  });

  test("reads named lorebooks and reports missing names", async () => {
    const payload = JSON.parse(
      textOf(
        await client.callTool("risu-agent-get-lorebooks", {
          names: ["Alice Lore", "Missing Lore"],
        }),
      ),
    );

    expect(payload.entries[0].content).toBe("Alice lives in a lab.");
    expect(payload.missing).toEqual(["Missing Lore"]);
  });
});
