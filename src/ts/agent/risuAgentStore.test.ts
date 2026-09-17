import { beforeEach, describe, expect, test, vi } from "vitest";

const store = vi.hoisted(() => {
  const characters: any[] = [];
  return {
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
});

vi.mock("../stores/domain/characterStore.svelte", () => ({
  characterStore: store,
}));
vi.mock("../stores/domain/messageStore.svelte", () => ({
  messageStore: {
    appendMessage: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
  },
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
} from "./risuAgentStore";
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
  store.characters.length = 0;
  vi.clearAllMocks();
  resetRisuAgentContextScopesForTesting();
});

describe("ensureRisuAgentCharacter", () => {
  test("creates and persists the reserved character when missing", async () => {
    const { character } = await ensureRisuAgentCharacter();

    expect(store.add).toHaveBeenCalledTimes(1);
    expect(store.flush).toHaveBeenCalled();
    expect(character.chaId).toBe(RISU_AGENT_CHARACTER_ID);
  });

  test("throws instead of returning an unhydrated summary", async () => {
    store.characters.push(makeAgentSummary());
    // ensureCharacterDetails silently fails and leaves detailsLoaded false.

    await expect(ensureRisuAgentCharacter()).rejects.toThrow(
      /could not be loaded/,
    );
  });

  test("returns the character once hydration actually completes", async () => {
    const summary = makeAgentSummary();
    store.characters.push(summary);
    store.ensureCharacterDetails.mockImplementationOnce(async () => {
      summary.detailsLoaded = true;
    });

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
    expect(store.markChatDirty).toHaveBeenCalledWith("c1");
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

describe("regenerate rollback", () => {
  function makeChatWithReply() {
    return {
      id: "agent-chat",
      name: "Chat",
      message: [
        { chatId: "u1", role: "user", data: "question" },
        { chatId: "r1", role: "char", data: "answer" },
      ],
      messageTotal: 2,
    } as any;
  }

  test("removing the last reply captures it with its original position", async () => {
    const chat = makeChatWithReply();

    const removed = await removeLastRisuAgentReply(chat);

    expect(removed).toEqual({
      message: { chatId: "r1", role: "char", data: "answer" },
      index: 1,
    });
    expect(chat.message.map((m: any) => m.chatId)).toEqual(["u1"]);
    expect(messageStore.deleteMessage).toHaveBeenCalledWith("agent-chat", "r1");
  });

  test("returns null when the last message is not an assistant reply", async () => {
    const chat = {
      id: "agent-chat",
      message: [{ chatId: "u1", role: "user", data: "question" }],
    } as any;

    expect(await removeLastRisuAgentReply(chat)).toBeNull();
    expect(messageStore.deleteMessage).not.toHaveBeenCalled();
  });

  test("restores a removed reply at its original position and persistence", async () => {
    const chat = makeChatWithReply();
    const removed = await removeLastRisuAgentReply(chat);
    expect(removed).not.toBeNull();
    // A failed retry may have appended a partial/error message.
    chat.message.push({ chatId: "e1", role: "char", data: "error" });
    const totalBeforeRestore = chat.messageTotal;

    await restoreRisuAgentReply(chat, removed!);

    expect(chat.message.map((m: any) => m.chatId)).toEqual([
      "u1",
      "r1",
      "e1",
    ]);
    expect(chat.messageTotal).toBe(totalBeforeRestore + 1);
    expect(messageStore.appendMessage).toHaveBeenCalledWith(
      "agent-chat",
      removed!.message,
    );
  });

  test("restoring twice never duplicates the reply", async () => {
    const chat = makeChatWithReply();
    const removed = await removeLastRisuAgentReply(chat);

    await restoreRisuAgentReply(chat, removed!);
    await restoreRisuAgentReply(chat, removed!);

    expect(chat.message.map((m: any) => m.chatId)).toEqual(["u1", "r1"]);
    expect(messageStore.appendMessage).toHaveBeenCalledTimes(1);
  });
});
