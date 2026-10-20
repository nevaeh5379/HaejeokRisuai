import { expect, test, vi } from "vitest";

const targetChar = vi.hoisted(() => ({
  chaId: "char-a",
  name: "Target",
  type: "character",
  chatPage: 1,
  chats: [
    { id: "chat-target", message: [{ role: "char", data: "target-history" }] },
    { id: "chat-ui", message: [{ role: "char", data: "current-ui-history" }] },
    {
      id: "chat-multi",
      message: [
        { role: "user", data: "msg-1" },
        { role: "char", data: "msg-2" },
        { role: "user", data: "msg-3" },
        { role: "char", data: "msg-4" },
        { role: "user", data: "msg-5" },
      ],
    },
  ],
}));

vi.mock("./utils", () => ({
  getCharacter: vi.fn(() => targetChar),
}));
vi.mock("../../../stores/domain/characterStore.svelte", () => ({
  characterStore: { characters: [targetChar], selectedId: 0, select: vi.fn() },
}));

import { ChatHandler } from "./chats";

function getResponseText(item?: { type: string; text?: string }): string {
  if (item?.type !== "text" || typeof item.text !== "string") {
    throw new Error("Expected text tool result");
  }
  return item.text;
}

test("reads chat history from the tool generation target", async () => {
  const handler = new ChatHandler();
  const result = await handler.getChatHistory("char-a", 20, 0, {
    currentChar: targetChar as never,
    chatTarget: { characterId: "char-a", chatId: "chat-target" },
  });

  const payload = JSON.parse(getResponseText(result[0]));
  expect(payload).toEqual([
    {
      type: "text",
      text: "Target: target-history",
    },
  ]);
});

test("paginates chat history from newest to oldest without reversing entire array", async () => {
  const handler = new ChatHandler();
  const page1 = await handler.getChatHistory("char-a", 2, 0, {
    currentChar: targetChar as never,
    chatTarget: { characterId: "char-a", chatId: "chat-multi" },
  });
  expect(JSON.parse(getResponseText(page1[0]))).toEqual([
    { type: "text", text: "User: msg-5" },
    { type: "text", text: "Target: msg-4" },
  ]);

  const page2 = await handler.getChatHistory("char-a", 2, 2, {
    currentChar: targetChar as never,
    chatTarget: { characterId: "char-a", chatId: "chat-multi" },
  });
  expect(JSON.parse(getResponseText(page2[0]))).toEqual([
    { type: "text", text: "User: msg-3" },
    { type: "text", text: "Target: msg-2" },
  ]);

  const page3 = await handler.getChatHistory("char-a", 2, 4, {
    currentChar: targetChar as never,
    chatTarget: { characterId: "char-a", chatId: "chat-multi" },
  });
  expect(JSON.parse(getResponseText(page3[0]))).toEqual([
    { type: "text", text: "User: msg-1" },
  ]);

  const pageOut = await handler.getChatHistory("char-a", 2, 10, {
    currentChar: targetChar as never,
    chatTarget: { characterId: "char-a", chatId: "chat-multi" },
  });
  expect(JSON.parse(getResponseText(pageOut[0]))).toEqual([]);
});
