import { expect, test, vi } from "vitest";

const getUserName = vi.hoisted(() =>
  vi.fn((target?: { characterIndex: number; chatIndex: number }) =>
    target?.characterIndex === 4 && target.chatIndex === 2
      ? "Target User"
      : "Selected User",
  ),
);

vi.mock("src/ts/storage/database.svelte", () => ({
  getDatabase: () => ({
    instructChatTemplate: "jinja",
    JinjaTemplate: "{{ risu_char }}|{{ risu_user }}",
  }),
  getCurrentCharacter: () => ({ name: "Selected Character" }),
}));

vi.mock("src/ts/util", () => ({ getUserName }));

import { applyChatTemplate } from "./chatTemplate";

test("renders explicit generation character and persona target", () => {
  const chatTarget = { characterIndex: 4, chatIndex: 2 };
  const result = applyChatTemplate([], {
    currentChar: { type: "character", name: "Target Character" } as never,
    chatTarget,
  });

  expect(result).toBe("Target Character|Target User");
  expect(getUserName).toHaveBeenCalledWith(chatTarget);
});
