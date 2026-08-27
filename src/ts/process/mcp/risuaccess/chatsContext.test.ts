import { expect, test, vi } from "vitest";

const targetChar = {
  chaId: "char-a",
  name: "Target",
  type: "character",
  chatPage: 1,
  chats: [
    { message: [{ role: "char", data: "target-history" }] },
    { message: [{ role: "char", data: "current-ui-history" }] },
  ],
};

vi.mock("./utils", () => ({
  getCharacter: vi.fn(() => targetChar),
}));

import { ChatHandler } from "./chats";

test("reads chat history from the tool generation target", async () => {
  const handler = new ChatHandler();
  const result = await handler.getChatHistory(
    "char-a",
    20,
    0,
    {
      currentChar: targetChar as never,
      chatTarget: { characterIndex: 2, chatIndex: 0 },
    },
  );

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
