import { describe, expect, test } from "vitest";
import type { Chat } from "../storage/database/schema";
import {
  canMutateRisuAgentSession,
  createRisuAgentChat,
  filterRisuAgentAttachableCharacters,
  isHydratedRisuAgentCharacter,
  normalizeRisuAgentChatContext,
  resolveRisuAgentChatId,
  resolveRisuAgentSessionContext,
  RISU_AGENT_CHARACTER_ID,
  RISU_AGENT_SYSTEM_INSTRUCTION,
} from "./risuAgentModel";

function chat(id: string, lastDate: number): Chat {
  return {
    id,
    name: id,
    note: "",
    localLore: [],
    message: [],
    lastDate,
  };
}

describe("Risu Agent model helpers", () => {
  test("uses the reserved identity distinct from Playground", () => {
    expect(RISU_AGENT_CHARACTER_ID).toBe("§risu-agent");
    expect(RISU_AGENT_CHARACTER_ID).not.toBe("§playground");
  });

  test("system instruction frames a general assistant with optional read-only Risu tools", () => {
    expect(RISU_AGENT_SYSTEM_INSTRUCTION).toMatch(/general-purpose AI assistant/i);
    expect(RISU_AGENT_SYSTEM_INSTRUCTION).toMatch(/optional/i);
    expect(RISU_AGENT_SYSTEM_INSTRUCTION).toMatch(/read-only/i);
  });

  test("resolves the preferred chat by stable id first", () => {
    const chats = [chat("chat-a", 50), chat("chat-b", 100)];
    expect(resolveRisuAgentChatId(chats, "chat-a", 1)).toBe("chat-a");
  });

  test("falls back to the persisted index when the id is unknown", () => {
    const chats = [chat("chat-a", 50), chat("chat-b", 100)];
    expect(resolveRisuAgentChatId(chats, "missing", 0)).toBe("chat-a");
  });

  test("falls back to the most recent chat when no hint matches", () => {
    const chats = [chat("chat-a", 50), chat("chat-b", 100)];
    expect(resolveRisuAgentChatId(chats, null, 99)).toBe("chat-b");
  });

  test("returns undefined for an empty session list", () => {
    expect(resolveRisuAgentChatId([], "chat-a", 0)).toBeUndefined();
    expect(resolveRisuAgentChatId(undefined, "chat-a", 0)).toBeUndefined();
  });

  test("creates empty sessions with a stable name", () => {
    const session = createRisuAgentChat(3);
    expect(session.name).toBe("Conversation 3");
    expect(session.message).toEqual([]);
    expect(session.id).toBeUndefined();
  });

  test("offers only ordinary attachable characters", () => {
    const characters = [
      { chaId: "ordinary-a", name: "Alice", type: "character" },
      { chaId: "§risu-agent", name: "Risu Agent", type: "character" },
      { chaId: "§playground", name: "Playground", type: "character" },
      { chaId: "trashed", name: "Old", type: "character", trashTime: 5 },
      { chaId: "group", name: "Group", type: "group" },
      { chaId: "ordinary-b", name: "Bob", type: "character" },
    ];

    expect(
      filterRisuAgentAttachableCharacters(characters, "").map((c) => c.chaId),
    ).toEqual(["ordinary-a", "ordinary-b"]);
    expect(
      filterRisuAgentAttachableCharacters(characters, "bo").map(
        (c) => c.chaId,
      ),
    ).toEqual(["ordinary-b"]);
    expect(filterRisuAgentAttachableCharacters(characters, "", 1)).toHaveLength(
      1,
    );
  });

  test("normalizes persisted session context to stable ids", () => {
    expect(normalizeRisuAgentChatContext(null)).toBeNull();
    expect(normalizeRisuAgentChatContext({})).toBeNull();
    expect(normalizeRisuAgentChatContext({ characterId: "  " })).toBeNull();
    expect(
      normalizeRisuAgentChatContext({ characterId: " char-a ", chatId: " " }),
    ).toEqual({ characterId: "char-a" });
    expect(
      normalizeRisuAgentChatContext({ characterId: "char-a", chatId: "c1" }),
    ).toEqual({ characterId: "char-a", chatId: "c1" });
  });

  test("reads session context from a chat summary safely", () => {
    expect(resolveRisuAgentSessionContext(null)).toBeNull();
    expect(resolveRisuAgentSessionContext({})).toBeNull();
    expect(
      resolveRisuAgentSessionContext({
        agentContext: { characterId: "char-a", chatId: "c1" },
      }),
    ).toEqual({ characterId: "char-a", chatId: "c1" });
  });

  test("treats lazy summaries and groups as not hydrated", () => {
    expect(isHydratedRisuAgentCharacter(null)).toBe(false);
    expect(isHydratedRisuAgentCharacter({ detailsLoaded: false })).toBe(false);
    expect(isHydratedRisuAgentCharacter({ type: "group" })).toBe(false);
    expect(isHydratedRisuAgentCharacter({ type: "character" })).toBe(true);
    expect(
      isHydratedRisuAgentCharacter({ type: "character", detailsLoaded: true }),
    ).toBe(true);
  });

  test("blocks session/context mutation only while busy", () => {
    expect(canMutateRisuAgentSession(false)).toBe(true);
    expect(canMutateRisuAgentSession(true)).toBe(false);
  });
});
