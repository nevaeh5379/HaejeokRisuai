// @vitest-environment happy-dom

import { writable } from "svelte/store";
import { expect, test, vi } from "vitest";

vi.mock("./stores.svelte", () => ({ selectedCharID: writable(0) }));
vi.mock("./stores/domain/characterStore.svelte", () => ({
  characterStore: {
    selectedId: 0,
    characters: [
      {
        chaId: "char-a",
        chatPage: 0,
        chats: [{ id: "chat-a", bindedPersona: "persona-a" }],
      },
      {
        chaId: "char-b",
        chatPage: 0,
        chats: [
          { id: "chat-b0", bindedPersona: "persona-a" },
          { id: "chat-b1", bindedPersona: "persona-b" },
        ],
      },
    ],
  },
}));
vi.mock("./stores/domain/personaStore.svelte", () => ({
  personaStore: {
    list: [
      {
        id: "persona-a",
        name: "Alpha",
        icon: "a.png",
        personaPrompt: "A prompt",
      },
      {
        id: "persona-b",
        name: "Beta",
        icon: "b.png",
        personaPrompt: "B prompt",
      },
    ],
    activePersona: {
      id: "persona-a",
      name: "Alpha",
      icon: "a.png",
      personaPrompt: "A prompt",
    },
  },
}));
vi.mock("./stores/domain/settingsStore.svelte", () => ({
  settingsStore: {
    state: {
      username: "Default User",
      userIcon: "default.png",
      personaPrompt: "Default prompt",
      personas: [
        {
          id: "persona-a",
          name: "Alpha",
          icon: "a.png",
          personaPrompt: "A prompt",
        },
        {
          id: "persona-b",
          name: "Beta",
          icon: "b.png",
          personaPrompt: "B prompt",
        },
      ],
    },
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

test("keeps selected-chat fallback for UI callers", () => {
  expect(getUserName()).toBe("Alpha");
});
