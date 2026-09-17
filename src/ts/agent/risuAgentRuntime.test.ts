import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => {
  const characters: any[] = [];

  const characterStore = {
    characters,
    add: vi.fn((char: any) => {
      characters.push(char);
      return characters.length - 1;
    }),
    flush: vi.fn(async () => {}),
    ensureCharacterDetails: vi.fn(async () => {}),
    ensureChatMessages: vi.fn(async () => {}),
    markChatDirty: vi.fn(),
    markChatManifestDirty: vi.fn(),
    markCharacterDirty: vi.fn(),
    getById: vi.fn((id: string) =>
      characters.find((char) => char?.chaId === id),
    ),
  };

  const messageStore = {
    appendMessage: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
  };

  const setRisuAgentContextScope = vi.fn();
  const clearRisuAgentContextScope = vi.fn();

  return {
    characters,
    characterStore,
    messageStore,
    setRisuAgentContextScope,
    clearRisuAgentContextScope,
  };
});

vi.mock("../stores/domain/characterStore.svelte", () => ({
  characterStore: state.characterStore,
}));
vi.mock("../stores/domain/messageStore.svelte", () => ({
  messageStore: state.messageStore,
}));
vi.mock("../process/mcp/risuagent/scope", () => ({
  setRisuAgentContextScope: state.setRisuAgentContextScope,
  clearRisuAgentContextScope: state.clearRisuAgentContextScope,
}));

import { beginChatGeneration, endChatGeneration } from "../process/chatRuntimeState";
import { RisuAgentRuntime } from "./risuAgentRuntime.svelte";

function agentChats(): any[] {
  const agent = state.characters.find(
    (char) => char?.chaId === "risu-agent" || char?.utilityBot === true,
  );
  return agent?.chats ?? [];
}

describe("RisuAgentRuntime initialization", () => {
  beforeEach(() => {
    state.characters.length = 0;
    vi.clearAllMocks();
  });

  test("concurrent ensure calls create at most one session", async () => {
    const runtime = new RisuAgentRuntime();

    await Promise.all([
      runtime.ensureInitialized(),
      runtime.ensureInitialized(),
      runtime.ensureInitialized(),
    ]);

    const chats = agentChats();
    expect(chats.length).toBe(1);
    expect(runtime.activeChatId).toBe(chats[0].id);
    expect(runtime.loading).toBe(false);
  });

  test("a repeated ensure after initialization does not add a session", async () => {
    const runtime = new RisuAgentRuntime();

    await runtime.ensureInitialized();
    const firstId = runtime.activeChatId;
    await runtime.ensureInitialized();
    await runtime.ensureInitialized();

    expect(agentChats().length).toBe(1);
    expect(runtime.activeChatId).toBe(firstId);
  });
});

describe("RisuAgentRuntime switching", () => {
  beforeEach(() => {
    state.characters.length = 0;
    vi.clearAllMocks();
  });

  test("switchTo persists selection, loads messages and scopes the session", async () => {
    const runtime = new RisuAgentRuntime();
    await runtime.ensureInitialized();
    await runtime.createNewConversation();
    const [first, second] = agentChats();

    await runtime.switchTo(first.id);

    expect(runtime.activeChatId).toBe(first.id);
    expect(state.characterStore.ensureChatMessages).toHaveBeenCalledWith(
      first.id,
    );
    const agent = state.characters.find((char) => char.utilityBot === true);
    expect(agent.chats[agent.chatPage].id).toBe(first.id);
    expect(second.id).not.toBe(first.id);
  });

  test("switchTo and createNewConversation are blocked while sending", async () => {
    const runtime = new RisuAgentRuntime();
    await runtime.ensureInitialized();
    const initialId = runtime.activeChatId;
    await runtime.createNewConversation();
    const second = agentChats()[1];

    runtime.sending = true;
    await runtime.switchTo(initialId!);
    await runtime.createNewConversation();

    expect(runtime.activeChatId).toBe(second.id);
    expect(agentChats().length).toBe(2);
    runtime.sending = false;
  });

  test("switchTo is blocked while the target session is generating", async () => {
    const runtime = new RisuAgentRuntime();
    await runtime.ensureInitialized();
    const initialId = runtime.activeChatId!;
    await runtime.createNewConversation();
    const activeId = runtime.activeChatId!;

    beginChatGeneration(activeId);
    try {
      await runtime.switchTo(initialId);
      expect(runtime.activeChatId).toBe(activeId);
    } finally {
      endChatGeneration(activeId);
    }
  });

  test("sortRisuAgentChats orders newest first", async () => {
    const runtime = new RisuAgentRuntime();
    await runtime.ensureInitialized();
    const agent = state.characters.find((char) => char.utilityBot === true);
    agent.chats[0].lastDate = 10;
    await runtime.createNewConversation();
    agentChats()[1].lastDate = 99;

    const { sortRisuAgentChats } = await import("./risuAgentRuntime.svelte");
    const sorted = sortRisuAgentChats(agent.chats);
    expect(sorted[0].lastDate).toBe(99);
  });
});
