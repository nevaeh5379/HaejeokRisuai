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
        { role: "user", data: "msg 0" },
        { role: "char", data: "msg 1" },
        { role: "user", data: "msg 2" },
        { role: "char", data: "msg 3" },
        { role: "user", data: "msg 4" },
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

test("paginates chat history with offset and count in newest-first order", async () => {
  const handler = new ChatHandler();

  // Offset 0, count 2 -> newest 2: msg 4, msg 3
  const page1 = await handler.getChatHistory("char-a", 2, 0, {
    currentChar: targetChar as never,
    chatTarget: { characterId: "char-a", chatId: "chat-multi" },
  });
  expect(JSON.parse((page1[0] as { text: string }).text)).toEqual([
    { type: "text", text: "User: msg 4" },
    { type: "text", text: "Target: msg 3" },
  ]);

  // Offset 2, count 2 -> msg 2, msg 1
  const page2 = await handler.getChatHistory("char-a", 2, 2, {
    currentChar: targetChar as never,
    chatTarget: { characterId: "char-a", chatId: "chat-multi" },
  });
  expect(JSON.parse((page2[0] as { text: string }).text)).toEqual([
    { type: "text", text: "User: msg 2" },
    { type: "text", text: "Target: msg 1" },
  ]);

  // Offset 4, count 3 -> msg 0 (only 1 remaining)
  const page3 = await handler.getChatHistory("char-a", 3, 4, {
    currentChar: targetChar as never,
    chatTarget: { characterId: "char-a", chatId: "chat-multi" },
  });
  expect(JSON.parse((page3[0] as { text: string }).text)).toEqual([
    { type: "text", text: "User: msg 0" },
  ]);

  // Offset out of bounds
  const pageOut = await handler.getChatHistory("char-a", 5, 10, {
    currentChar: targetChar as never,
    chatTarget: { characterId: "char-a", chatId: "chat-multi" },
  });
  expect(JSON.parse((pageOut[0] as { text: string }).text)).toEqual([]);
});
