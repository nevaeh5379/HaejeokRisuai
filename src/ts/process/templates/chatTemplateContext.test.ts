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
vi.mock("src/ts/stores/domain/presetStore.svelte", () => ({
  presetStore: {
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

test("formats messages and preserves original message immutability", () => {
  const originalMessages = [
    { role: "system" as const, content: "You are helpful." },
    { role: "user" as const, content: "Hello!" },
    { role: "assistant" as const, content: "Greetings!" },
  ];
  const inputCopy = [
    { role: "system" as const, content: "You are helpful." },
    { role: "user" as const, content: "Hello!" },
    { role: "assistant" as const, content: "Greetings!" },
  ];

  const result = applyChatTemplate(originalMessages, {
    type: "chatml",
    currentChar: { type: "character", name: "Assistant" } as never,
  });

  expect(result).toContain("<|im_start|>system\nYou are helpful.<|im_end|>");
  expect(result).toContain("<|im_start|>user\nHello!<|im_end|>");
  expect(result).toContain("<|im_start|>assistant\nGreetings!<|im_end|>");
  expect(result).toContain("<|im_start|>assistant\n");

  // Input messages must not be mutated
  expect(originalMessages).toEqual(inputCopy);
});

test("handles no_system_messages and alter_user_assistant_roles without input mutation", () => {
  const messages = [
    { role: "system" as const, content: "Rules" },
    { role: "user" as const, content: "Hi" },
  ];
  const originalSnapshot = [
    { role: "system" as const, content: "Rules" },
    { role: "user" as const, content: "Hi" },
  ];

  const result = applyChatTemplate(messages, {
    type: "mistral",
    currentChar: { type: "character", name: "Bot" } as never,
  });

  expect(result).toContain("[INST]");
  expect(messages).toEqual(originalSnapshot);
});
