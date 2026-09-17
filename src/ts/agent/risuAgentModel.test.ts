import { describe, expect, test } from "vitest";
import type { Chat } from "../storage/database/schema";
import {
  createRisuAgentChat,
  resolveRisuAgentChatId,
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
});
