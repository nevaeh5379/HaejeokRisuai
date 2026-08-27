import { expect, test, vi } from "vitest";

const getUserName = vi.hoisted(() =>
  vi.fn((target?: { characterId: string; chatId: string }) =>
    target?.characterId === "char-target" && target.chatId === "chat-target"
      ? "Target User"
      : "Selected User",
  ),
);

vi.mock("src/ts/stores/domain/settingsStore.svelte", () => ({
  settingsStore: {
    state: {
      instructChatTemplate: "jinja",
      JinjaTemplate: "{{ risu_char }}|{{ risu_user }}",
    },
  },
}));
vi.mock("src/ts/stores/domain/characterStore.svelte", () => ({
  characterStore: { currentCharacter: { name: "Selected Character" } },
}));

vi.mock("src/ts/util", () => ({ getUserName }));

import { applyChatTemplate } from "./chatTemplate";

test("renders explicit generation character and persona target", () => {
  const chatTarget = { characterId: "char-target", chatId: "chat-target" };
  const result = applyChatTemplate([], {
    currentChar: { type: "character", name: "Target Character" } as never,
    chatTarget,
  });

  expect(result).toBe("Target Character|Target User");
  expect(getUserName).toHaveBeenCalledWith(chatTarget);
});
