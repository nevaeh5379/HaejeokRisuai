// @vitest-environment node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, expect, test, vi } from "vitest";

const commitMessages = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../parser/parser.svelte", () => ({
  hasher: vi.fn(),
  risuChatParser: vi.fn(),
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

vi.mock("../storage/database.svelte", () => ({
  getCurrentCharacter: vi.fn(() => ({})),
  getCurrentChat: vi.fn(() => ({ message: [] })),
  getDatabase: vi.fn(() => ({ characters: [] })),
  setDatabase: vi.fn(),
}));

vi.mock("../stores/domain/characterStore.svelte", () => ({
  characterStore: { characters: [{ name: "", chats: [{ message: [] }] }] },
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
  getModuleLorebooks: vi.fn(() => []),
  getModuleTriggers: vi.fn(() => []),
}));

vi.mock("./files/inlays", () => ({
  getInlayAsset: vi.fn(),
  writeInlayImage: vi.fn(),
}));
vi.mock("./lorebook.svelte", () => ({ loadLoreBookV3Prompt: vi.fn() }));
vi.mock("./memory/hypamemory", () => ({ HypaProcesser: vi.fn() }));
vi.mock("./request/request", () => ({ requestChatData: vi.fn() }));
vi.mock("./stableDiff", () => ({ generateAIImage: vi.fn() }));

let runScripted: typeof import("./scriptings").runScripted;

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
