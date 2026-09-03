import { expect, test, vi } from "vitest";

const fallbackCharacter = vi.hoisted(() => ({ name: "UI Character" }));
const getCurrentCharacter = vi.hoisted(() => vi.fn(() => fallbackCharacter));

vi.mock("../../stores/domain/characterStore.svelte", () => ({
  characterStore: {
    get currentCharacter() {
      return getCurrentCharacter();
    },
  },
}));

import { resolveRequestCharacter } from "./requestContext";

test("prefers the request character over the current UI selection", () => {
  const target = { name: "Generation Character" };
  expect(resolveRequestCharacter({ currentChar: target } as never)).toBe(
    target,
  );
  expect(getCurrentCharacter).not.toHaveBeenCalled();
});

test("falls back to the current UI character for auxiliary callers", () => {
  getCurrentCharacter.mockClear();
  expect(resolveRequestCharacter({} as never)).toBe(fallbackCharacter);
  expect(getCurrentCharacter).toHaveBeenCalledOnce();
});
