import { expect, test, vi } from "vitest";

const getUserName = vi.hoisted(() =>
  vi.fn((target?: { characterId: string; chatId: string }) =>
    target?.characterId === "char-target" ? "Target User" : "Selected User",
  ),
);

vi.mock("../util", () => ({ getUserName }));
vi.mock("../stores/domain/settingsStore.svelte", () => ({
  settingsStore: {
    state: {
      ooba: {
        formating: {
          systemPrefix: "",
          userPrefix: "",
          assistantPrefix: "",
          seperator: "\n",
          useName: true,
        },
      },
      autoSuggestPrefix: "",
      username: "Selected User",
    },
  },
}));

import {
  getUnstringlizerChunks,
  stringlizeAINChat,
  stringlizeChatOba,
} from "./stringlize";

const target = { characterId: "char-target", chatId: "chat-target" };

test("builds response trimming chunks with the target persona name", () => {
  const { chunks } = getUnstringlizerChunks([], "Bot", "normal", target);
  expect(chunks).toContain("Target User:");
  expect(chunks).not.toContain("Selected User:");
});

test("formats named Ooba user turns with the target persona", () => {
  const result = stringlizeChatOba(
    [{ role: "user", content: "hello" }],
    "Bot",
    false,
    true,
    target,
  );
  expect(result).toContain("Target User: hello");
  expect(result).not.toContain("Selected User");
});

test("formats AIN user dialogue with the target persona", () => {
  const result = stringlizeAINChat(
    [{ role: "user", content: "「hello」" }],
    "Bot",
    true,
    target,
  );
  expect(result).toContain("Target User 「hello」");
  expect(result).not.toContain("Selected User");
});
