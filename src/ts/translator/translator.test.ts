import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  googleFetch: vi.fn(),
  preset: { aiModel: "gpt" },
  settings: {
    translatorType: "deeplX",
    translator: "ko",
    translatorInputLanguage: "en",
    noWaitForTranslate: true,
    deeplXOptions: { url: "https://deeplx.test", token: "" },
    deeplOptions: { freeApi: true, key: "test-key" },
    htmlTranslation: false,
    combineTranslation: false,
  },
}));

vi.mock("../stores/domain/settingsStore.svelte", () => ({
  settingsStore: { state: mocks.settings },
}));
vi.mock("../stores/domain/presetStore.svelte", () => ({
  presetStore: { state: mocks.preset },
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
  mocks.googleFetch.mockReset();
  mocks.settings.translatorType = "deeplX";
  mocks.settings.translator = "ko";
  mocks.settings.translatorInputLanguage = "en";
  mocks.preset.aiModel = "gpt";
  vi.stubGlobal("fetch", mocks.googleFetch);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("translation direction and cache context", () => {
  it("translates an explicit English input into French for TTS and playground requests", async () => {
    const { runTranslator } = await import("./translator");
    mocks.fetch.mockResolvedValue({ ok: true, data: { data: "Bonjour" } });

    await expect(runTranslator("Hello", "en", "fr")).resolves.toBe("Bonjour");
    expect(mocks.fetch.mock.calls[0][1].body).toEqual({
      text: "Hello",
      source_lang: "EN",
      target_lang: "FR",
    });
  });

  it("uses the requested Google source language instead of the chat setting", async () => {
    const { runTranslator } = await import("./translator");
    mocks.settings.translatorType = "google";
    mocks.googleFetch.mockResolvedValue({ json: async () => "Bonjour" });

    await runTranslator("Hola", "es", "fr");
    const url = new URL(mocks.googleFetch.mock.calls[0][0]);
    expect(url.searchParams.get("sl")).toBe("es");
    expect(url.searchParams.get("tl")).toBe("fr");
  });

  it("keeps chat forward translation and reverse restoration in the intended direction", async () => {
    const { translate } = await import("./translator");
    mocks.fetch.mockResolvedValue({ ok: true, data: { data: "안녕하세요" } });

    await expect(translate("Hello", false)).resolves.toBe("안녕하세요");
    await expect(translate("안녕하세요", true)).resolves.toBe("Hello");
    expect(mocks.fetch.mock.calls[0][1].body).toMatchObject({
      source_lang: "EN",
      target_lang: "KO",
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a Korean result after changing the chat target to Japanese", async () => {
    const { translate } = await import("./translator");
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      data: { data: "안녕하세요" },
    });
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      data: { data: "こんにちは" },
    });

    await expect(translate("Hello", false)).resolves.toBe("안녕하세요");
    mocks.settings.translator = "ja";
    await expect(translate("Hello", false)).resolves.toBe("こんにちは");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a result from a different engine", async () => {
    const { translate } = await import("./translator");
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      data: { data: "DeepLX result" },
    });
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      data: { translations: [{ text: "DeepL result" }] },
    });

    await expect(translate("Hello", false)).resolves.toBe("DeepLX result");
    mocks.settings.translatorType = "deepl";
    await expect(translate("Hello", false)).resolves.toBe("DeepL result");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("separates the model's English and Japanese source languages", async () => {
    const { translate } = await import("./translator");
    mocks.fetch.mockImplementation(async (_url, options) => ({
      ok: true,
      data: { data: options.body.source_lang },
    }));

    await expect(translate("same text", false)).resolves.toBe("EN");
    mocks.preset.aiModel = "novellist";
    await expect(translate("same text", false)).resolves.toBe("JA");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("separates Google chat source language settings", async () => {
    const { translate } = await import("./translator");
    mocks.settings.translatorType = "google";
    mocks.googleFetch.mockImplementation(async (url) => ({
      json: async () => new URL(url).searchParams.get("sl"),
    }));

    mocks.settings.translatorInputLanguage = "es";
    await expect(translate("same text", false)).resolves.toBe("es");
    mocks.settings.translatorInputLanguage = "fr";
    await expect(translate("same text", false)).resolves.toBe("fr");
    expect(mocks.googleFetch).toHaveBeenCalledTimes(2);
  });

  it("does not return an explicit translation in a different language to chat", async () => {
    const { runTranslator, translate } = await import("./translator");
    mocks.fetch.mockResolvedValueOnce({ ok: true, data: { data: "Bonjour" } });
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      data: { data: "안녕하세요" },
    });

    await runTranslator("Hello", "en", "fr");
    await expect(translate("Hello", false)).resolves.toBe("안녕하세요");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not short-circuit explicit translation requests with the chat cache", async () => {
    const { runTranslator } = await import("./translator");
    mocks.fetch.mockResolvedValueOnce({ ok: true, data: { data: "Bonjour" } });
    mocks.fetch.mockResolvedValueOnce({ ok: true, data: { data: "Salut" } });

    await expect(runTranslator("Hello", "en", "fr")).resolves.toBe("Bonjour");
    await expect(runTranslator("Hello", "en", "fr")).resolves.toBe("Salut");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("retries a failed request instead of caching its original-text fallback", async () => {
    const { translate } = await import("./translator");
    mocks.fetch.mockResolvedValueOnce({ ok: false, data: "provider failed" });
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      data: { data: "안녕하세요" },
    });

    await expect(translate("Hello", false)).resolves.toBe("Hello");
    await expect(translate("Hello", false)).resolves.toBe("안녕하세요");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps VOX translation directed from English to Japanese", async () => {
    const { translateVox } = await import("./translator");
    mocks.fetch.mockResolvedValue({ ok: true, data: { data: "こんにちは" } });

    await expect(translateVox("Hello")).resolves.toBe("こんにちは");
    expect(mocks.fetch.mock.calls[0][1].body).toMatchObject({
      source_lang: "EN",
      target_lang: "JA",
    });
  });

  it("uses the requested reverse Google direction after automatic source detection", async () => {
    const { translate } = await import("./translator");
    mocks.settings.translatorType = "google";
    mocks.settings.translatorInputLanguage = "auto";
    mocks.googleFetch.mockResolvedValueOnce({ json: async () => "안녕하세요" });
    mocks.googleFetch.mockResolvedValueOnce({ json: async () => "Hello" });

    await expect(translate("Hello", false)).resolves.toBe("안녕하세요");
    await expect(translate("안녕하세요", true)).resolves.toBe("Hello");
    const urls = mocks.googleFetch.mock.calls.map(([url]) => new URL(url));
    expect(
      urls.map((url) => [
        url.searchParams.get("sl"),
        url.searchParams.get("tl"),
      ]),
    ).toEqual([
      ["auto", "ko"],
      ["ko", "en"],
    ]);
  });

  it("keeps DeepL automatic detection and honors an explicit source without forcing EN-US", async () => {
    const { runTranslator, translate } = await import("./translator");
    mocks.settings.translatorType = "deepl";
    mocks.settings.translatorInputLanguage = "auto";
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      data: { translations: [{ text: "안녕하세요" }] },
    });
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      data: { translations: [{ text: "Hello" }] },
    });

    await translate("Hello", false);
    await runTranslator("안녕", "ko", "en");
    expect(
      mocks.fetch.mock.calls.map(([_url, options]) => options.body),
    ).toEqual([
      { text: ["Hello"], target_lang: "KO" },
      { text: ["안녕"], source_lang: "KO", target_lang: "EN" },
    ]);
  });

  it("evicts the least recently used entries instead of growing without a bound", async () => {
    const { translate } = await import("./translator");
    mocks.fetch.mockImplementation(async (_url, options) => ({
      ok: true,
      data: { data: `${options.body.text}-translated` },
    }));

    for (let i = 0; i < 64; i++) await translate(`message-${i}`, false);
    await translate("message-0", false);
    await translate("message-64", false);
    await translate("message-0", false);
    expect(mocks.fetch).toHaveBeenCalledTimes(65);

    await translate("message-1", false);
    expect(mocks.fetch).toHaveBeenCalledTimes(66);
  });
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

    await expect(runTranslator(text, "en", "ko")).resolves.toBe(text);
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
