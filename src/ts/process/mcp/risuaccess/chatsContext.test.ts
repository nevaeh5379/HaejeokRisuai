import { expect, test, vi } from "vitest";

const targetChar = vi.hoisted(() => ({
  chaId: "char-a",
  name: "Target",
  type: "character",
  chatPage: 1,
  chats: [
    { id: "chat-target", message: [{ role: "char", data: "target-history" }] },
    {
      id: "chat-multi",
      message: [
        { role: "user", data: "msg-0" },
        { role: "char", data: "msg-1" },
        { role: "user", data: "msg-2" },
        { role: "char", data: "msg-3" },
        { role: "user", data: "msg-4" },
      ],
    },
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

test("paginates chat history newest first without allocating whole-array clones", async () => {
  const handler = new ChatHandler();
  // Fetch offset 1, count 2 from chat-multi (messages are msg-0..msg-4)
  // Newest first order is: msg-4, msg-3, msg-2, msg-1, msg-0
  // Offset 1, count 2 should be: msg-3, msg-2
  const result = await handler.getChatHistory("char-a", 2, 1, {
    currentChar: targetChar as never,
    chatTarget: { characterId: "char-a", chatId: "chat-multi" },
  });

  expect(result[0]?.type).toBe("text");
  if (result[0]?.type !== "text") throw new Error("Expected text tool result");
  const payload = JSON.parse(result[0].text);
  expect(payload).toEqual([
    { type: "text", text: "Target: msg-3" },
    { type: "text", text: "User: msg-2" },
  ]);

  // Out of bounds offset returns empty array
  const outOfBounds = await handler.getChatHistory("char-a", 5, 10, {
    currentChar: targetChar as never,
    chatTarget: { characterId: "char-a", chatId: "chat-multi" },
  });
  if (outOfBounds[0]?.type !== "text") throw new Error("Expected text result");
  expect(JSON.parse(outOfBounds[0].text)).toEqual([]);
});
