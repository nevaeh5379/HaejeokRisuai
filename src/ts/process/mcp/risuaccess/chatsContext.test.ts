import { expect, test, vi } from "vitest";

const targetChar = vi.hoisted(() => ({
  chaId: "char-a",
  name: "Target",
  type: "character",
  chatPage: 1,
  chats: [
    { id: "chat-target", message: [{ role: "char", data: "target-history" }] },
    { id: "chat-ui", message: [{ role: "char", data: "current-ui-history" }] },
  ],
}));

vi.mock("./utils", () => ({
  getCharacter: vi.fn(() => targetChar),
}));
vi.mock("../../../stores/domain/characterStore.svelte", () => ({
  characterStore: { characters: [targetChar], selectedId: 0, select: vi.fn() },
}));

import { ChatHandler } from "./chats";

test("reads chat history from the tool generation target", async () => {
  const handler = new ChatHandler();
  const result = await handler.getChatHistory("char-a", 20, 0, {
    currentChar: targetChar as never,
    chatTarget: { characterId: "char-a", chatId: "chat-target" },
  });

  expect(result[0]?.type).toBe("text");
  if (result[0]?.type !== "text") throw new Error("Expected text tool result");
  const payload = JSON.parse(result[0].text);
  expect(payload).toEqual([
    {
      type: "text",
      text: "Target: target-history",
    },
  ]);
});

test("reads chat history with newest-first offset and count windowing", async () => {
  targetChar.chats[0] = {
    id: "chat-target",
    message: [
      { role: "user", data: "msg-0" },
      { role: "char", data: "msg-1" },
      { role: "user", data: "msg-2" },
      { role: "char", data: "msg-3" },
      { role: "user", data: "msg-4" },
    ],
  };

  const handler = new ChatHandler();
  // newest-first order is: msg-4, msg-3, msg-2, msg-1, msg-0
  const page1 = await handler.getChatHistory("char-a", 2, 0, {
    currentChar: targetChar as never,
    chatTarget: { characterId: "char-a", chatId: "chat-target" },
  });
  if (page1[0]?.type !== "text") throw new Error("Expected text result");
  expect(JSON.parse(page1[0].text)).toEqual([
    { type: "text", text: "User: msg-4" },
    { type: "text", text: "Target: msg-3" },
  ]);

  const page2 = await handler.getChatHistory("char-a", 2, 1, {
    currentChar: targetChar as never,
    chatTarget: { characterId: "char-a", chatId: "chat-target" },
  });
  if (page2[0]?.type !== "text") throw new Error("Expected text result");
  expect(JSON.parse(page2[0].text)).toEqual([
    { type: "text", text: "Target: msg-3" },
    { type: "text", text: "User: msg-2" },
  ]);

  const pageEmpty = await handler.getChatHistory("char-a", 2, 10, {
    currentChar: targetChar as never,
    chatTarget: { characterId: "char-a", chatId: "chat-target" },
  });
  if (pageEmpty[0]?.type !== "text") throw new Error("Expected text result");
  expect(JSON.parse(pageEmpty[0].text)).toEqual([]);
});
