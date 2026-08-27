import { expect, test, vi } from "vitest";

const parser = vi.hoisted(() =>
  vi.fn((text: string, arg?: any) =>
    `${text}:${arg?.chatTarget?.characterIndex ?? "missing"}`,
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
  const target = { characterIndex: 4, chatIndex: 2 };

  const result = exampleMessage(char, "User", target);

  expect(result[0].content).toBe("hello:4");
  expect(parser).toHaveBeenCalledWith("hello", {
    chara: char,
    chatTarget: target,
  });
});
