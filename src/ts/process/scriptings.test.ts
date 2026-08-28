// @vitest-environment node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, expect, test, vi } from "vitest";

const commitMessages = vi.hoisted(() => vi.fn(async () => undefined));
const moduleTriggers = vi.hoisted(() => vi.fn(() => []));
const moduleLorebooks = vi.hoisted(() => vi.fn(() => []));
const databaseState = vi.hoisted(() => ({
  value: {
    characters: [
      {
        type: "character",
        chaId: "target-room",
        name: "Target Room",
        chats: [{ id: "target-chat", message: [] }],
      },
    ],
  } as any,
}));
const currentChatState = vi.hoisted(() => ({ value: { message: [] } as any }));
const getChatVarMock = vi.hoisted(() => vi.fn(() => "target-value"));
const getGlobalChatVarMock = vi.hoisted(() => vi.fn(() => "global-value"));
const setChatVarMock = vi.hoisted(() => vi.fn());

vi.mock("../parser/chatVar.svelte", () => ({
  getChatVar: getChatVarMock,
  getGlobalChatVar: getGlobalChatVarMock,
  setChatVar: setChatVarMock,
}));

vi.mock("../parser/parser.svelte", () => ({
  hasher: vi.fn(),
  risuChatParser: vi.fn(
    (value: string, options?: { triggerId?: string; chara?: { name?: string } }) =>
      value
        .replaceAll("{{trigger_id}}", options?.triggerId ?? "null")
        .replaceAll("{{char}}", options?.chara?.name ?? "fallback"),
  ),
}));

vi.mock("../alert", () => ({
  alertConfirm: vi.fn(),
  alertError: vi.fn(),
  alertInput: vi.fn(),
  alertNormal: vi.fn(),
  alertSelect: vi.fn(),
}));

vi.mock("../globalApi.svelte", () => ({
  fetchNative: vi.fn(),
  readImage: vi.fn(),
}));
vi.mock("../tokenizer", () => ({ tokenize: vi.fn() }));
vi.mock("../util", () => ({
  asBuffer: vi.fn(),
  getPersonaPrompt: vi.fn(),
  getUserIcon: vi.fn(),
  getUserName: vi.fn(),
}));

vi.mock("../stores/domain/characterStore.svelte", () => ({
  characterStore: {
    get characters() {
      return databaseState.value.characters;
    },
    get currentCharacter() {
      return databaseState.value.characters[0];
    },
    get currentChat() {
      return currentChatState.value;
    },
    markCharacterDirty: vi.fn(),
    markChatDirty: vi.fn(),
  },
}));
vi.mock("../stores/domain/settingsStore.svelte", () => ({
  settingsStore: { state: { maxContext: 4096 } },
}));

vi.mock("../stores/domain/messageStore.svelte", () => ({
  messageStore: { commitMessages },
}));

vi.mock("../stores.svelte", () => ({
  ReloadChatPointer: { update: vi.fn() },
  ReloadGUIPointer: { update: vi.fn() },
  selectedCharID: {
    subscribe: (run: (value: number) => void) => (run(0), () => undefined),
  },
}));

vi.mock("./modules", () => ({
  getModuleLorebooks: moduleLorebooks,
  getModuleTriggers: moduleTriggers,
}));

vi.mock("./files/inlays", () => ({
  getInlayAsset: vi.fn(),
  writeInlayImage: vi.fn(),
}));
vi.mock("./lorebook.svelte", () => ({ loadLoreBookV3Prompt: vi.fn() }));
vi.mock("./memory/hypamemory", () => ({ HypaProcesser: vi.fn() }));
vi.mock("./request/chatRequestOrchestrator", () => ({ requestChatData: vi.fn() }));
vi.mock("./stableDiff", () => ({ generateAIImage: vi.fn() }));

let runScripted: typeof import("./scriptings").runScripted;
let runLuaEditTrigger: typeof import("./scriptings").runLuaEditTrigger;
let runLuaButtonTrigger: typeof import("./scriptings").runLuaButtonTrigger;

beforeAll(async () => {
  const jsonLua = await readFile(
    resolve(process.cwd(), "public/lua/json.lua"),
    "utf8",
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(jsonLua, { status: 200 })),
  );
  const scriptings = await import("./scriptings");
  runScripted = scriptings.runScripted;
  runLuaEditTrigger = scriptings.runLuaEditTrigger;
  runLuaButtonTrigger = scriptings.runLuaButtonTrigger;
});

test("does not stop generation when setStateChanged is a no-op", async () => {
  const result = await runScripted(
    `
      function onStart(id)
        return setStateChanged(id, "unchanged", "value")
      end
    `,
    {
      char: {} as never,
      chat: { message: [] } as never,
      setVar: () => false,
      getVar: () => "null",
      mode: "start",
    },
  );

  expect(result.stopSending).toBe(false);
  expect(result.res).toBeNull();
});

test("keeps explicit false as the generation stop signal", async () => {
  const result = await runScripted("function onStart() return false end", {
    char: {} as never,
    chat: { message: [] } as never,
    mode: "start",
  });

  expect(result.res).toBe(false);
  expect(result.stopSending).toBe(true);
});

test("reuses a Lua engine with the current character and chat context", async () => {
  commitMessages.mockClear();
  const code = `
    function onStart(id)
      addChat(id, "user", getName(id))
      if getName(id) == "Beta" then stopChat(id) end
    end
  `;
  const firstChat = { id: "chat-a", message: [] as { role: string; data: string }[] };
  const secondChat = { id: "chat-b", message: [] as { role: string; data: string }[] };

  const first = await runScripted(code, {
    char: { type: "character", chaId: "a", name: "Alpha" } as never,
    chat: firstChat as never,
    mode: "start",
  });
  const second = await runScripted(code, {
    char: { type: "character", chaId: "b", name: "Beta" } as never,
    chat: secondChat as never,
    mode: "start",
  });

  expect(firstChat.message).toEqual([{ role: "user", data: "Alpha" }]);
  expect(secondChat.message).toEqual([{ role: "user", data: "Beta" }]);
  expect(first.stopSending).toBe(false);
  expect(second.stopSending).toBe(true);
});

test("passes explicit chat targets to default Lua chat variables", async () => {
  getChatVarMock.mockClear();
  const target = { characterId: "target-room", chatId: "target-chat" };
  const result = await runScripted(
    'function onStart(id) return getChatVar(id, "key") end',
    {
      char: { type: "character", chaId: "target", name: "Target" } as never,
      chat: { message: [] } as never,
      chatTarget: target,
      mode: "start",
    },
  );

  expect(result.res).toBe("target-value");
  expect(getChatVarMock).toHaveBeenCalledWith("key", target);
});

test("reuses Lua CBS with the trigger id from each invocation", async () => {
  const code = 'function onStart(id) return cbs("{{trigger_id}}") end';
  const first = await runScripted(code, {
    chat: { message: [] } as never,
    triggerId: "trigger-a",
    mode: "start",
  });
  const second = await runScripted(code, {
    chat: { message: [] } as never,
    triggerId: "trigger-b",
    mode: "start",
  });

  expect(first.res).toBe("trigger-a");
  expect(second.res).toBe("trigger-b");
});

test("keeps Lua CBS on the generation target for simple snapshots", async () => {
  const result = await runScripted(
    'function onStart(id) return cbs("{{char}}") end',
    {
      char: { type: "simple", name: "Snapshot" } as never,
      chat: { message: [] } as never,
      chatTarget: { characterId: "target-room", chatId: "target-chat" },
      mode: "start",
    },
  );

  expect(result.res).toBe("Target Room");
});

test("persists a user message added by Lua", async () => {
  commitMessages.mockClear();
  const chat = { id: "chat-1", message: [] } as never;

  await runScripted(
    'function onStart(id) addChat(id, "user", "persist me") end',
    { char: {} as never, chat, mode: "start" },
  );

  expect(commitMessages).toHaveBeenCalledOnce();
  expect(commitMessages).toHaveBeenCalledWith("chat-1", [
    { role: "user", data: "persist me" },
  ]);
});

test("does not persist when Lua only reads chat messages", async () => {
  commitMessages.mockClear();
  const chat = {
    id: "chat-1",
    message: [{ role: "user", data: "hello" }],
  } as never;

  await runScripted("function onStart(id) getChatData(id, 0) end", {
    char: {} as never,
    chat,
    mode: "start",
  });

  expect(commitMessages).not.toHaveBeenCalled();
});

test("does not persist when Lua sets a chat message to the same value", async () => {
  commitMessages.mockClear();
  const chat = {
    id: "chat-1",
    message: [{ role: "char", data: "same text" }],
  } as never;

  await runScripted(
    `
      function onStart(id)
        local msg = getChat(id, 0)
        setChat(id, 0, msg.data)
      end
    `,
    { char: {} as never, chat, mode: "start" },
  );

  expect(commitMessages).not.toHaveBeenCalled();
});

test("preserves message metadata when Lua replaces the full chat", async () => {
  commitMessages.mockClear();
  const chat: any = {
    id: "chat-1",
    message: [
      {
        role: "char",
        data: "before",
        chatId: "message-1",
        time: 123,
        name: "Narrator",
        generationInfo: { model: "test-model" },
      },
    ],
  } as never;

  await runScripted(
    `
      function onStart(id)
        local full = getFullChat(id)
        full[1].data = "after"
        setFullChat(id, full)
      end
    `,
    { char: {} as never, chat, mode: "start" },
  );

  expect(chat.message[0]).toMatchObject({
    role: "char",
    data: "after",
    chatId: "message-1",
    time: 123,
    name: "Narrator",
    generationInfo: { model: "test-model" },
  });
  expect(commitMessages).toHaveBeenCalledWith("chat-1", chat.message);
});

test("checks module button triggers when character triggers are missing", async () => {
  moduleTriggers.mockClear();

  await expect(
    runLuaButtonTrigger(
      {
        type: "simple",
        chaId: "char-1",
        customscript: [],
        triggerscript: undefined,
      } as never,
      "module-button",
    ),
  ).resolves.toBeUndefined();

  expect(moduleTriggers).toHaveBeenCalledOnce();
});

test("resolves module edit triggers against the explicit character", async () => {
  moduleTriggers.mockClear();
  moduleTriggers.mockReturnValue([]);
  const char = {
    type: "character",
    chaId: "char-a",
    name: "Alpha",
    triggerscript: [],
  } as never;

  const target = {
    characterId: "target-room",
    chatId: "target-chat",
  };
  await expect(
    runLuaEditTrigger(char, "editoutput", "hello", undefined, target),
  ).resolves.toBe("hello");
  expect(moduleTriggers).toHaveBeenCalledWith(
    char,
    undefined,
    databaseState.value.characters[0].chats[0],
  );
});

test("pins Lua module button actions to the clicked chat target", async () => {
  commitMessages.mockClear();
  moduleTriggers.mockReset();
  setChatVarMock.mockClear();

  const targetChat = { id: "target-chat", message: [] as any[] };
  const otherChat = { id: "other-chat", message: [] as any[] };
  databaseState.value = {
    characters: [
      {
        type: "character",
        chaId: "target-room",
        name: "Target Room",
        chatPage: 1,
        chats: [targetChat, otherChat],
        triggerscript: [],
      },
    ],
  } as any;
  currentChatState.value = otherChat as any;
  moduleTriggers.mockReturnValue([
    {
      effect: [
        {
          type: "triggerlua",
          code: `
            function onButtonClick(id, button)
              if button == "target-button" then
                setState(id, "button-state", { ok = true })
                addChat(id, "user", "target chat only")
              end
            end
          `,
        },
      ],
      lowLevelAccess: false,
    },
  ] as never);

  const target = { characterId: "target-room", chatId: "target-chat" };
  const result = await runLuaButtonTrigger(
    {
      type: "simple",
      chaId: "snapshot",
      customscript: [],
      triggerscript: undefined,
    } as never,
    "target-button",
    target,
  );

  expect(result.chat).toBe(targetChat);
  expect(targetChat.message).toEqual([
    { role: "user", data: "target chat only" },
  ]);
  expect(otherChat.message).toEqual([]);
  expect(moduleTriggers).toHaveBeenCalledWith(
    databaseState.value.characters[0],
    undefined,
    targetChat,
  );
  expect(setChatVarMock).toHaveBeenCalledWith(
    "__button-state",
    expect.any(String),
    target,
  );
  expect(commitMessages).toHaveBeenCalledWith("target-chat", targetChat.message);

  moduleTriggers.mockReset();
  databaseState.value = {
    characters: [
      {
        type: "character",
        chaId: "target-room",
        name: "Target Room",
        chats: [{ id: "target-chat", message: [] }],
      },
    ],
  } as any;
  currentChatState.value = { message: [] } as any;
});

test("runs module button actions that read lorebooks before character details hydrate", async () => {
  commitMessages.mockClear();
  moduleTriggers.mockReset();
  moduleLorebooks.mockReset();

  databaseState.value = {
    characters: [
      {
        type: undefined,
        chatPage: 0,
        chats: [{ localLore: [] }],
        globalLore: undefined,
      },
    ],
  } as any;
  currentChatState.value = { id: "chat-1", message: [] } as any;
  moduleLorebooks.mockReturnValue([
    { comment: "ChoiceModule.actions", content: "module action" },
  ] as never);
  moduleTriggers.mockReturnValue([
    {
      effect: [
        {
          type: "triggerlua",
          code: `
            function onButtonClick(id, button)
              local books = getLoreBooks(id, "ChoiceModule.actions")
              if button == "module-button" and #books > 0 then
                addChat(id, "user", "module button worked")
              end
            end
          `,
        },
      ],
      lowLevelAccess: false,
    },
  ] as never);

  const result = await runLuaButtonTrigger(
    {
      type: "simple",
      chaId: "char-1",
      customscript: [],
      triggerscript: undefined,
    } as never,
    "module-button",
  );

  expect(result.chat.message).toEqual([
    { role: "user", data: "module button worked" },
  ]);
  expect(commitMessages).toHaveBeenCalledOnce();

  moduleTriggers.mockReset();
  moduleLorebooks.mockReset();
  databaseState.value = { characters: [] } as any;
  currentChatState.value = { message: [] } as any;
});
