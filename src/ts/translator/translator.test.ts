import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  settings: {
    translatorType: "deeplX",
    translator: "ko",
    translatorInputLanguage: "en",
    noWaitForTranslate: true,
    deeplXOptions: { url: "https://deeplx.test", token: "" },
    htmlTranslation: false,
    combineTranslation: false,
  },
}));

vi.mock("../stores/domain/settingsStore.svelte", () => ({
  settingsStore: { state: mocks.settings },
}));
vi.mock("../stores/domain/presetStore.svelte", () => ({
  presetStore: { state: { aiModel: "gpt" } },
}));
vi.mock("../stores/domain/characterStore.svelte", () => ({
  characterStore: { characters: [] },
}));
vi.mock("../globalApi.svelte", () => ({ globalFetch: mocks.fetch }));
vi.mock("../process/modules", () => ({ getModuleRegexScripts: () => [] }));
vi.mock("../process/request/chatRequestOrchestrator", () => ({
  requestChatData: vi.fn(),
}));
vi.mock("../parser/parser.svelte", () => ({
  applyMarkdownToNode: vi.fn(),
  risuChatParser: vi.fn(),
}));
vi.mock("../process/scripts", () => ({ processScriptFull: vi.fn() }));
vi.mock("../util", () => ({ sleep: vi.fn(), getNodetextToSentence: vi.fn() }));
vi.mock("../alert", () => ({ alertError: vi.fn() }));
vi.mock("../stores.svelte", async () => {
  const { writable } = await import("svelte/store");
  return { selectedCharID: writable(-1) };
});
vi.mock("../process/chat/runtimeState", async () => {
  const { writable } = await import("svelte/store");
  return { doingChat: writable(false) };
});

beforeEach(() => {
  vi.resetModules();
  mocks.fetch.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("plain text translation chunks", () => {
  it.each([
    "The big\ndog",
    "First\nSecond\nThird",
    "First\n\n\nSecond",
    "First\n{{img::asset}}\n{{raw::asset}}\nSecond",
    "First\n\n{{video::asset}}\n\nSecond",
  ])("preserves line boundaries and protected markers (%j)", async (text) => {
    const { runTranslator } = await import("./translator");
    mocks.fetch.mockImplementation(async (_url, options) => ({
      ok: true,
      data: { data: options.body.text },
    }));

    await expect(runTranslator(text, false, "ko", "en")).resolves.toBe(text);
    const requests = mocks.fetch.mock.calls.map(
      ([_url, options]) => options.body.text,
    );
    expect(
      requests.every((request) => !/\{\{(?:img|raw|video)/.test(request)),
    ).toBe(true);
    if (text === "The big\ndog") expect(requests).toEqual([text]);
  });
});

describe("HTML super-chunk fallback", () => {
  it.each([
    "translated without separator",
    "part1■part2■unexpected extra part",
  ])(
    "returns individually translated nodes when separator count differs (%s)",
    async (combinedResult) => {
      const { translateHTML } = await import("./translator");
      mocks.fetch.mockResolvedValueOnce({
        ok: true,
        data: { data: combinedResult },
      });
      mocks.fetch.mockResolvedValueOnce({
        ok: true,
        data: { data: "첫 문장" },
      });
      mocks.fetch.mockResolvedValueOnce({
        ok: true,
        data: { data: "둘째 문장" },
      });

      const result = await translateHTML(
        "<p>first</p><p>second</p>",
        false,
        "",
        -1,
      );
      const container = document.createElement("div");
      container.innerHTML = result;
      expect(
        Array.from(container.querySelectorAll("p"), (node) => node.textContent),
      ).toEqual(["첫 문장", "둘째 문장"]);
      expect(
        mocks.fetch.mock.calls.map(([_url, options]) => options.body.text),
      ).toEqual(["first\n■\nsecond", "first", "second"]);
    },
  );

  it("uses the combined result directly when separator count matches", async () => {
    const { translateHTML } = await import("./translator");
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      data: { data: "첫 문장■둘째 문장" },
    });

    const result = await translateHTML(
      "<p>first</p><p>second</p>",
      false,
      "",
      -1,
    );
    const container = document.createElement("div");
    container.innerHTML = result;
    expect(
      Array.from(container.querySelectorAll("p"), (node) => node.textContent),
    ).toEqual(["첫 문장", "둘째 문장"]);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
