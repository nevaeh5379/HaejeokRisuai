import { beforeEach, expect, test, vi } from "vitest";

const { processScriptFull, settingsState } = vi.hoisted(() => ({
  processScriptFull: vi.fn(),
  settingsState: { removeIncompleteResponse: false },
}));

vi.mock("./scripts", () => ({ processScriptFull }));
vi.mock("../stores/domain/settingsStore.svelte", () => ({
  settingsStore: { state: settingsState },
}));
vi.mock("../stores/domain/characterStore.svelte", () => ({
  characterStore: { characters: [] },
}));
vi.mock("../util", () => ({
  trimUntilPunctuation: (value: string) => value,
}));

import {
  processStreamingRerollValues,
  type StreamDisplayOptions,
} from "./chatStreamingDisplay.svelte";

beforeEach(() => {
  processScriptFull.mockReset();
  settingsState.removeIncompleteResponse = false;
});

test("applies editoutput scripts to cached streaming rerolls", async () => {
  const room = { type: "character" };
  const options = {
    nowChatroom: room,
    prefix: "continued: ",
    msgIndex: 7,
    reformatContent: (value: string) => `formatted(${value})`,
  } as StreamDisplayOptions;
  processScriptFull.mockResolvedValue({
    data: "module-regex-applied",
    emoChanged: false,
  });

  await expect(
    processStreamingRerollValues(
      options,
      ["primary raw", "cached raw"],
      "primary processed",
    ),
  ).resolves.toEqual(["primary processed", "module-regex-applied"]);
  expect(processScriptFull).toHaveBeenCalledOnce();
  expect(processScriptFull).toHaveBeenCalledWith(
    room,
    "formatted(continued: cached raw)",
    "editoutput",
    7,
  );
});
