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
        chatPage: 0,
        chats: [
          { id: "chat-b0" },
          { id: "chat-b1", bindedPersona: "persona-b" },
        ],
      },
    ],
  },
}));
vi.mock("./stores/domain/personaStore.svelte", () => {
  const list = [
    {
      id: "persona-a",
      name: "Alpha",
      icon: "a.png",
      personaPrompt: "A prompt",
      botLorebooks: {
        "char-a": [{ comment: "alpha-a" }],
        "char-b": [{ comment: "alpha-b" }],
      },
    },
    {
      id: "persona-b",
      name: "Beta",
      icon: "b.png",
      personaPrompt: "B prompt",
      botLorebooks: { "char-b": [{ comment: "beta-b" }] },
    },
  ];
  return { personaStore: { list, activePersona: list[0] } };
});
vi.mock("./stores/domain/settingsStore.svelte", () => ({
  settingsStore: { state: {} },
}));
vi.mock("src/ts/platform", () => ({
  isIOS: () => false,
  isTauri: false,
}));

import {
  checkPersonaBinded,
  getPersonaLorebooks,
  getPersonaPrompt,
  getUserIcon,
  getUserName,
} from "./util";
import { characterStore } from "./stores/domain/characterStore.svelte";

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

test("uses lorebooks from the persona bound to the explicit bot target", () => {
  const target = { characterId: "char-b", chatId: "chat-b1" };
  expect(getPersonaLorebooks(target).map((book) => book.comment)).toEqual(["beta-b"]);
});

test("uses the active persona lorebooks when the target chat has no binding", () => {
  const target = { characterId: "char-b", chatId: "chat-b0" };
  expect(getPersonaLorebooks(target).map((book) => book.comment)).toEqual(["alpha-b"]);
});

test("falls back to the active persona when a saved persona binding is stale", () => {
  const target = { characterId: "char-b", chatId: "chat-b1" };
  const chat = (characterStore.characters[1] as any).chats[1];
  const originalBinding = chat.bindedPersona;
  chat.bindedPersona = "missing-persona";
  try {
    expect(getPersonaLorebooks(target).map((book) => book.comment)).toEqual(["alpha-b"]);
  } finally {
    chat.bindedPersona = originalBinding;
  }
});
