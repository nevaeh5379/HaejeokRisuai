import { beforeEach, describe, expect, it, vi } from "vitest";
import type { character } from "../storage/database/schema";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  translate: vi.fn(),
  sleep: vi.fn(),
  alertError: vi.fn(),
}));

vi.mock("../stores/domain/characterStore.svelte", () => ({
  characterStore: {},
}));
vi.mock("../stores/domain/settingsStore.svelte", () => ({
  settingsStore: { state: { huggingfaceKey: "test-key" } },
}));
vi.mock("../translator/translator", () => ({
  runTranslator: mocks.translate,
  translateVox: vi.fn(),
}));
vi.mock("../globalApi.svelte", () => ({
  globalFetch: vi.fn(),
  loadAsset: vi.fn(),
}));
vi.mock("src/lang", () => ({
  language: { errors: { httpError: "HTTP error: " } },
}));
vi.mock("../util", () => ({ sleep: mocks.sleep }));
vi.mock("../alert", () => ({ alertError: mocks.alertError }));
vi.mock("./transformers", () => ({ runVITS: vi.fn() }));
vi.mock("./ttsHooks", () => ({
  getTTSPreprocessors: () => [],
  // Exercise successful requests without requiring a native audio decoder.
  getTTSPostprocessors: () => [() => ({ skip: true })],
  runHookPipeline: async (_hooks, ctx) => ({ ctx, skip: false }),
}));

import { sayTTS } from "./tts";

const voice = (language: string) =>
  ({
    chaId: "tts-test",
    ttsMode: "huggingface",
    hfTTS: { language, model: "test/voice" },
  }) as character;

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.translate.mockReset();
  mocks.sleep.mockReset().mockResolvedValue(undefined);
  mocks.alertError.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
});

const loadingResponse = () =>
  new Response(JSON.stringify({ estimated_time: 1 }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
const audioResponse = () =>
  new Response(new Uint8Array([1, 2]), {
    status: 200,
    headers: { "content-type": "audio/wav" },
  });

describe("Hugging Face TTS model-loading retries", () => {
  it("translates the original text once and retries with the same translated payload", async () => {
    mocks.translate
      .mockResolvedValueOnce("Bonjour")
      .mockResolvedValue("corrupted retry");
    mocks.fetch.mockResolvedValueOnce(loadingResponse());
    mocks.fetch.mockResolvedValueOnce(loadingResponse());
    mocks.fetch.mockResolvedValueOnce(audioResponse());

    await sayTTS(voice("fr"), "Hello");

    expect(mocks.translate).toHaveBeenCalledExactlyOnceWith(
      "Hello",
      "en",
      "fr",
    );
    expect(
      mocks.fetch.mock.calls.map(
        ([_url, options]) => JSON.parse(options.body).inputs,
      ),
    ).toEqual(["Bonjour", "Bonjour", "Bonjour"]);
    expect(mocks.sleep).toHaveBeenCalledTimes(2);
    expect(mocks.alertError).not.toHaveBeenCalled();
  });

  it("retries English text without invoking translation", async () => {
    mocks.fetch.mockResolvedValueOnce(loadingResponse());
    mocks.fetch.mockResolvedValueOnce(audioResponse());

    await sayTTS(voice("en"), "Hello");

    expect(mocks.translate).not.toHaveBeenCalled();
    expect(
      mocks.fetch.mock.calls.map(
        ([_url, options]) => JSON.parse(options.body).inputs,
      ),
    ).toEqual(["Hello", "Hello"]);
    expect(mocks.alertError).not.toHaveBeenCalled();
  });
});
