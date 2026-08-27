import { expect, test, vi } from "vitest";

const parser = vi.hoisted(() =>
  vi.fn((text: string, arg?: any) =>
    `${text}:${arg?.chatTarget?.characterId ?? "missing"}`,
  ),
);

vi.mock("./scripts", () => ({ risuChatParser: parser }));

import { exampleMessage } from "./exampleMessages";

test("parses example messages with the generation chat target", () => {
  const char = {
    type: "character",
    name: "Target",
    exampleMessage: "{{char}}: hello",
  } as any;
  const target = { characterId: "char-target", chatId: "chat-target" };

  const result = exampleMessage(char, "User", target);

  expect(result[0].content).toBe("hello:char-target");
  expect(parser).toHaveBeenCalledWith("hello", {
    chara: char,
    chatTarget: target,
  });
});
