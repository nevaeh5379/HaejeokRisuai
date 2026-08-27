// @vitest-environment happy-dom

import { writable } from "svelte/store";
import { expect, test, vi } from "vitest";

vi.mock("./stores.svelte", () => ({ selectedCharID: writable(0) }));
vi.mock("./stores/domain/characterStore.svelte", () => ({
  characterStore: {
    characters: [
      { chatPage: 0, chats: [{ bindedPersona: "persona-a" }] },
      {
        chatPage: 0,
        chats: [{ bindedPersona: "persona-a" }, { bindedPersona: "persona-b" }],
      },
    ],
  },
}));
vi.mock("./stores/domain/settingsStore.svelte", () => ({
  settingsStore: {
    state: {
      personas: [
        { id: "persona-a", name: "Alpha", icon: "a.png", personaPrompt: "A prompt" },
        { id: "persona-b", name: "Beta", icon: "b.png", personaPrompt: "B prompt" },
      ],
    },
  },
}));
vi.mock("./storage/database.svelte", () => ({
  getDatabase: () => ({
    username: "Default User",
    userIcon: "default.png",
    personaPrompt: "Default prompt",
  }),
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
  const target = { characterIndex: 1, chatIndex: 1 };
  expect(checkPersonaBinded(target)?.id).toBe("persona-b");
  expect(getUserName(target)).toBe("Beta");
  expect(getUserIcon(target)).toBe("b.png");
  expect(getPersonaPrompt(target)).toBe("B prompt");
});

test("keeps selected-chat fallback for UI callers", () => {
  expect(getUserName()).toBe("Alpha");
});
