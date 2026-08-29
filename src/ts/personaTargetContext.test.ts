// @vitest-environment happy-dom

import { writable } from "svelte/store";
import { expect, test, vi } from "vitest";

vi.mock("./stores.svelte", () => ({ selectedCharID: writable(0) }));
vi.mock("./stores/domain/characterStore.svelte", () => ({
  characterStore: {
    selectedId: 0,
    characters: [
      { chaId: "char-a", chatPage: 0, chats: [{ id: "chat-a", bindedPersona: "persona-a" }] },
      {
        chaId: "char-b",
        fixedPersonaId: "persona-c",
        chatPage: 0,
        chats: [
          { id: "chat-b0" },
          { id: "chat-b1", bindedPersona: "persona-b" },
        ],
      },
    ],
  },
}));
const { personas } = vi.hoisted(() => ({
  personas: [
    { id: "persona-a", name: "Alpha", icon: "a.png", personaPrompt: "A prompt" },
    { id: "persona-b", name: "Beta", icon: "b.png", personaPrompt: "B prompt" },
    { id: "persona-c", name: "Gamma", icon: "c.png", personaPrompt: "C prompt" },
  ],
}));

vi.mock("./stores/domain/settingsStore.svelte", () => ({
  settingsStore: {
    state: {
      username: "Default User",
      userIcon: "default.png",
      personaPrompt: "Default prompt",
    },
  },
}));
vi.mock("./stores/domain/personaStore.svelte", () => ({
  personaStore: {
    list: personas,
    activePersona: personas[0],
  },
}));
vi.mock("src/ts/platform", () => ({
  isIOS: () => false,
  isTauri: false,
}));

import {
  checkPersonaBinded,
  getPersonaPrompt,
  getUserIcon,
  getUserName,
} from "./util";

test("resolves persona helpers from an explicit chat target", () => {
  const target = { characterId: "char-b", chatId: "chat-b1" };
  expect(checkPersonaBinded(target)?.id).toBe("persona-b");
  expect(getUserName(target)).toBe("Beta");
  expect(getUserIcon(target)).toBe("b.png");
  expect(getPersonaPrompt(target)).toBe("B prompt");
});

test("uses a character-level fixed persona when the chat has no override", () => {
  const target = { characterId: "char-b", chatId: "chat-b0" };
  expect(checkPersonaBinded(target)).toBeNull();
  expect(getUserName(target)).toBe("Gamma");
  expect(getUserIcon(target)).toBe("c.png");
  expect(getPersonaPrompt(target)).toBe("C prompt");
});

test("chat-level persona binding overrides the character-level fixed persona", () => {
  const target = { characterId: "char-b", chatId: "chat-b1" };
  expect(checkPersonaBinded(target)?.id).toBe("persona-b");
  expect(getUserName(target)).toBe("Beta");
});

test("keeps selected-chat fallback for UI callers", () => {
  expect(getUserName()).toBe("Alpha");
});
