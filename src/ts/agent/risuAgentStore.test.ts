import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => {
  const characters: any[] = [];

  const findChat = (chatId: string) => {
    for (const char of characters) {
      const chat = char?.chats?.find(
        (candidate: any) => candidate?.id === chatId,
      );
      if (chat) return chat;
    }
    return undefined;
  };

  const characterStore = {
    characters,
    add: vi.fn((char: any) => {
      characters.push(char);
      return characters.length - 1;
    }),
    flush: vi.fn(async () => {}),
    ensureCharacterDetails: vi.fn(async () => {}),
    markChatDirty: vi.fn(),
    markChatManifestDirty: vi.fn(),
    markCharacterDirty: vi.fn(),
    getById: vi.fn((id: string) =>
      characters.find((char) => char?.chaId === id),
    ),
  };

  // Mirrors the real MessageStore contract: the store owns the in-memory
  // removal and the messageTotal decrement together.
  const messageStore = {
    appendMessage: vi.fn(async (chatId: string, message: any) => {
      const chat = findChat(chatId);
      if (!chat) return;
      chat.message ??= [];
      const existingIndex = chat.message.findIndex(
        (candidate: any) => candidate.chatId === message.chatId,
      );
      if (existingIndex >= 0) chat.message[existingIndex] = message;
      else chat.message.push(message);
    }),
    deleteMessage: vi.fn(async (chatId: string, messageId: string) => {
      const chat = findChat(chatId);
      if (!chat || !Array.isArray(chat.message)) return;
      const before = chat.message.length;
      chat.message = chat.message.filter(
        (candidate: any) => candidate.chatId !== messageId,
      );
      const deletedCount = before - chat.message.length;
      if (deletedCount > 0 && typeof chat.messageTotal === "number") {
        chat.messageTotal = Math.max(0, chat.messageTotal - deletedCount);
      }
    }),
  };

  return { characters, findChat, characterStore, messageStore };
});

vi.mock("../stores/domain/characterStore.svelte", () => ({
  characterStore: state.characterStore,
}));
vi.mock("../stores/domain/messageStore.svelte", () => ({
  messageStore: state.messageStore,
}));

import {
  getRisuAgentContextScope,
  resetRisuAgentContextScopesForTesting,
} from "../process/mcp/risuagent/scope";
import {
  ensureRisuAgentCharacter,
  registerRisuAgentSessionScope,
  removeLastRisuAgentReply,
  restoreRisuAgentReply,
  setRisuAgentSessionContext,
  getRisuAgentPromptConfig,
  setRisuAgentPromptConfig,
} from "./risuAgentStore";
import { createDefaultRisuAgentPromptSettings } from "./risuAgentPrompt";
import { RISU_AGENT_CHARACTER_ID } from "./risuAgentModel";
import { messageStore } from "../stores/domain/messageStore.svelte";

function makeAgentSummary() {
  return {
    chaId: RISU_AGENT_CHARACTER_ID,
    type: "character",
    name: "Risu Agent",
    detailsLoaded: false,
    chats: [],
    chatPage: 0,
  } as any;
}

beforeEach(() => {
  state.characters.length = 0;
  vi.clearAllMocks();
  resetRisuAgentContextScopesForTesting();
});

describe("ensureRisuAgentCharacter", () => {
  test("creates and persists the reserved character when missing", async () => {
    const { character } = await ensureRisuAgentCharacter();

    expect(state.characterStore.add).toHaveBeenCalledTimes(1);
    expect(state.characterStore.flush).toHaveBeenCalled();
    expect(character.chaId).toBe(RISU_AGENT_CHARACTER_ID);
  });

  test("throws instead of returning an unhydrated summary", async () => {
    state.characters.push(makeAgentSummary());
    // ensureCharacterDetails silently fails and leaves detailsLoaded false.

    await expect(ensureRisuAgentCharacter()).rejects.toThrow(
      /could not be loaded/,
    );
  });

  test("returns the character once hydration actually completes", async () => {
    const summary = makeAgentSummary();
    state.characters.push(summary);
    state.characterStore.ensureCharacterDetails.mockImplementationOnce(
      async () => {
        summary.detailsLoaded = true;
      },
    );

    const { character } = await ensureRisuAgentCharacter();

    expect(character.detailsLoaded).toBe(true);
  });
});

describe("per-session context registry", () => {
  function makeCharacterWithChats() {
    return {
      chaId: RISU_AGENT_CHARACTER_ID,
      type: "character",
      name: "Risu Agent",
      detailsLoaded: true,
      chatPage: 0,
      chats: [
        { id: "c1", name: "Chat 1", message: [] },
        { id: "c2", name: "Chat 2", message: [] },
      ],
    } as any;
  }

  test("persists context on the session and only registers that chat id", async () => {
    const character = makeCharacterWithChats();

    await setRisuAgentSessionContext(character, "c1", {
      characterId: "char-a",
      chatId: "chat-a",
    });

    expect(character.chats[0].agentContext).toEqual({
      characterId: "char-a",
      chatId: "chat-a",
    });
    expect(state.characterStore.markChatDirty).toHaveBeenCalledWith("c1");
    expect(getRisuAgentContextScope("c1")).toEqual({
      characterId: "char-a",
      chatId: "chat-a",
    });
    // A different session must not inherit the attachment.
    expect(getRisuAgentContextScope("c2")).toBeUndefined();
  });

  test("detaching one session never clears another session's scope", async () => {
    const character = makeCharacterWithChats();
    await setRisuAgentSessionContext(character, "c1", {
      characterId: "char-a",
    });
    await setRisuAgentSessionContext(character, "c2", {
      characterId: "char-b",
    });

    await setRisuAgentSessionContext(character, "c1", null);

    expect(character.chats[0].agentContext).toBeUndefined();
    expect(getRisuAgentContextScope("c1")).toBeUndefined();
    expect(getRisuAgentContextScope("c2")).toEqual({ characterId: "char-b" });
  });

  test("registering a detached session clears only that chat id", () => {
    const character = makeCharacterWithChats();
    character.chats[1].agentContext = { characterId: "char-b" };
    registerRisuAgentSessionScope(character.chats[1]);
    expect(getRisuAgentContextScope("c2")).toEqual({ characterId: "char-b" });

    registerRisuAgentSessionScope(character.chats[0]);
    expect(getRisuAgentContextScope("c1")).toBeUndefined();
    expect(getRisuAgentContextScope("c2")).toEqual({ characterId: "char-b" });
  });
});

function registerChatInStore(chat: any) {
  state.characters.push({
    chaId: "holder",
    type: "character",
    name: "Holder",
    chats: [chat],
  });
  return chat;
}

describe("regenerate rollback", () => {
  function makeChatWithReply() {
    return registerChatInStore({
      id: "agent-chat",
      name: "Chat",
      message: [
        { chatId: "u1", role: "user", data: "question" },
        { chatId: "r1", role: "char", data: "answer" },
      ],
      messageTotal: 2,
    });
  }

  test("removing the last reply decrements messageTotal exactly once", async () => {
    const chat = makeChatWithReply();

    const removed = await removeLastRisuAgentReply(chat);

    expect(removed).toEqual({
      message: { chatId: "r1", role: "char", data: "answer" },
      index: 1,
    });
    expect(chat.message.map((m: any) => m.chatId)).toEqual(["u1"]);
    expect(chat.messageTotal).toBe(1);
    expect(messageStore.deleteMessage).toHaveBeenCalledWith("agent-chat", "r1");
  });

  test("returns null when the last message is not an assistant reply", async () => {
    const chat = registerChatInStore({
      id: "agent-chat",
      message: [{ chatId: "u1", role: "user", data: "question" }],
      messageTotal: 1,
    });

    expect(await removeLastRisuAgentReply(chat)).toBeNull();
    expect(chat.messageTotal).toBe(1);
    expect(messageStore.deleteMessage).not.toHaveBeenCalled();
  });

  test("removes safely and decrements once without chat/message ids", async () => {
    const chat = registerChatInStore({
      message: [
        { chatId: "u1", role: "user", data: "question" },
        { role: "char", data: "answer" },
      ],
      messageTotal: 2,
    });

    const removed = await removeLastRisuAgentReply(chat);

    expect(removed?.index).toBe(1);
    expect(messageStore.deleteMessage).not.toHaveBeenCalled();
    expect(chat.message).toHaveLength(1);
    expect(chat.messageTotal).toBe(1);
  });

  test("falls back to a single local decrement when the store cannot resolve the chat", async () => {
    // Chat id exists but the chat is not registered in the character store.
    const chat = {
      id: "orphan-chat",
      message: [
        { chatId: "u1", role: "user", data: "question" },
        { chatId: "r1", role: "char", data: "answer" },
      ],
      messageTotal: 2,
    } as any;

    const removed = await removeLastRisuAgentReply(chat);

    expect(removed?.index).toBe(1);
    expect(messageStore.deleteMessage).toHaveBeenCalledWith(
      "orphan-chat",
      "r1",
    );
    expect(chat.message.map((m: any) => m.chatId)).toEqual(["u1"]);
    expect(chat.messageTotal).toBe(1);
  });

  test("restores a removed reply to its exact original count and position", async () => {
    const chat = makeChatWithReply();
    const originalTotal = chat.messageTotal;
    const removed = await removeLastRisuAgentReply(chat);
    expect(removed).not.toBeNull();
    expect(chat.messageTotal).toBe(originalTotal - 1);
    // A failed retry may have appended a partial/error message.
    chat.message.push({ chatId: "e1", role: "char", data: "error" });

    await restoreRisuAgentReply(chat, removed!);

    expect(chat.message.map((m: any) => m.chatId)).toEqual(["u1", "r1", "e1"]);
    expect(chat.messageTotal).toBe(originalTotal);
    expect(messageStore.appendMessage).toHaveBeenCalledWith(
      "agent-chat",
      removed!.message,
    );
  });

  test("restoring twice never duplicates the reply or overcounts", async () => {
    const chat = makeChatWithReply();
    const originalTotal = chat.messageTotal;
    const removed = await removeLastRisuAgentReply(chat);

    await restoreRisuAgentReply(chat, removed!);
    await restoreRisuAgentReply(chat, removed!);

    expect(chat.message.map((m: any) => m.chatId)).toEqual(["u1", "r1"]);
    expect(chat.messageTotal).toBe(originalTotal);
    expect(messageStore.appendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("agent prompt configuration persistence", () => {
  beforeEach(() => {
    state.characters.length = 0;
    vi.clearAllMocks();
  });

  test("a legacy reserved character has no prompt config (defaults win)", async () => {
    const { character } = await ensureRisuAgentCharacter();
    expect((character as any).agentPrompt).toBeUndefined();
    expect(getRisuAgentPromptConfig(character)).toBeNull();
  });

  test("persists on the reserved character through dirty/flush", async () => {
    const { character } = await ensureRisuAgentCharacter();
    await setRisuAgentPromptConfig(character, {
      promptTemplate: [
        { type: "plain", text: "agent only", role: "system" } as any,
      ],
      promptSettings: {
        ...createDefaultRisuAgentPromptSettings(),
        utilOverride: true,
      },
    });

    const saved = getRisuAgentPromptConfig(character);
    expect(saved?.promptTemplate).toHaveLength(1);
    expect((saved?.promptTemplate[0] as any).text).toBe("agent only");
    expect(saved?.promptSettings.utilOverride).toBe(true);
    expect(state.characterStore.markCharacterDirty).toHaveBeenCalledWith(
      RISU_AGENT_CHARACTER_ID,
    );
    expect(state.characterStore.flush).toHaveBeenCalled();
  });

  test("the persisted value is an owned clone of the draft", async () => {
    const { character } = await ensureRisuAgentCharacter();
    const draft = {
      promptTemplate: [{ type: "plain", text: "draft", role: "system" } as any],
      promptSettings: createDefaultRisuAgentPromptSettings(),
    };
    await setRisuAgentPromptConfig(character, draft);

    (draft.promptTemplate[0] as any).text = "edited after save";
    expect(((character as any).agentPrompt.promptTemplate[0] as any).text).toBe(
      "draft",
    );
  });

  test("null and malformed data fall back to defaults without deleting chats", async () => {
    const { character } = await ensureRisuAgentCharacter();
    const before = (character.chats ?? []).length;

    await setRisuAgentPromptConfig(character, {
      promptTemplate: [],
      promptSettings: {
        ...createDefaultRisuAgentPromptSettings(),
        utilOverride: true,
      },
    });
    expect((character as any).agentPrompt).toBeDefined();

    await setRisuAgentPromptConfig(character, null);
    expect((character as any).agentPrompt).toBeUndefined();
    expect(getRisuAgentPromptConfig(character)).toBeNull();
    expect((character.chats ?? []).length).toBe(before);

    (character as any).agentPrompt = {
      promptTemplate: "not-an-array",
      promptSettings: 7,
    };
    expect(getRisuAgentPromptConfig(character)).toBeNull();
  });
});
