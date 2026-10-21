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
        { role: "user", data: "msg0" },
        { role: "char", data: "msg1" },
        { role: "user", data: "msg2" },
        { role: "char", data: "msg3" },
        { role: "user", data: "msg4" },
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

test("returns newest-first chat history with window pagination without allocating reversed array", async () => {
  const handler = new ChatHandler();
  const result = await handler.getChatHistory("char-a", 2, 1, {
    currentChar: targetChar as never,
    chatTarget: { characterId: "char-a", chatId: "chat-multi" },
  });

  expect(result[0]?.type).toBe("text");
  if (result[0]?.type !== "text") throw new Error("Expected text tool result");
  const payload = JSON.parse(result[0].text);
  // Total 5 messages [0, 1, 2, 3, 4]. Newest first: [4, 3, 2, 1, 0].
  // offset 1, count 2 should yield [3, 2]
  expect(payload).toEqual([
    { type: "text", text: "Target: msg3" },
    { type: "text", text: "User: msg2" },
  ]);
});
