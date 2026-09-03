import { expect, test, vi } from "vitest";

const requestChatData = vi.hoisted(() =>
  vi.fn(async () => ({ type: "success", result: "ok" }) as const),
);

vi.mock("../request/chatRequestOrchestrator", () => ({ requestChatData }));

import { AIAccessClient } from "./aiaccess";

test("forwards tool generation context into nested LLM requests", async () => {
  const client = new AIAccessClient();
  const currentChar = { name: "Target", chaId: "char-a" } as never;
  const chatTarget = { characterId: "char-a", chatId: "chat-a" };

  await client.callTool(
    "runLLM",
    {
      model: "lite",
      messages: [{ role: "user", content: "hello" }],
    },
    { currentChar, chatTarget },
  );

  expect(requestChatData).toHaveBeenCalledWith(
    expect.objectContaining({
      currentChar,
      triggerTarget: chatTarget,
      formated: [{ role: "user", content: "hello" }],
    }),
    "otherAx",
  );
});
