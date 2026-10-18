import { beforeEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({ translate: vi.fn() }));

vi.mock("@browsermt/bergamot-translator", () => ({
  LatencyOptimisedTranslator: class {
    translate = engine.translate;
  },
  TranslatorBacking: class {},
}));

vi.mock("../util", () => ({ asBuffer: (buffer: ArrayBuffer) => buffer }));

beforeEach(() => {
  vi.resetModules();
  engine.translate.mockReset();
});

describe("Bergamot translation queue", () => {
  it("reports the failed request and allows a later translation to succeed", async () => {
    const { bergamotTranslate } = await import("./bergamotTranslator");
    const error = new Error("model download failed");
    engine.translate.mockRejectedValueOnce(error);
    engine.translate.mockResolvedValueOnce({ target: { text: "translated" } });

    await expect(bergamotTranslate("first", "en", "ko", false)).rejects.toBe(
      error,
    );
    await expect(bergamotTranslate("second", "en", "ko", false)).resolves.toBe(
      "translated",
    );
    expect(engine.translate).toHaveBeenCalledTimes(2);
  });

  it("keeps overlapping requests serialized even when the active request fails", async () => {
    const { bergamotTranslate } = await import("./bergamotTranslator");
    let rejectFirst: (error: Error) => void;
    engine.translate.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    engine.translate.mockResolvedValueOnce({
      target: { text: "second result" },
    });
    engine.translate.mockResolvedValueOnce({
      target: { text: "third result" },
    });

    const first = bergamotTranslate("first", "en", "ko", false);
    const second = bergamotTranslate("second", "en", "ko", false);
    const third = bergamotTranslate("third", "en", "ko", false);
    const completion = Promise.allSettled([first, second, third]);
    await vi.waitFor(() => expect(engine.translate).toHaveBeenCalledTimes(1));

    const error = new Error("bad input");
    rejectFirst(error);
    expect(await completion).toEqual([
      { status: "rejected", reason: error },
      { status: "fulfilled", value: "second result" },
      { status: "fulfilled", value: "third result" },
    ]);
    expect(
      engine.translate.mock.calls.map(([request]) => request.text),
    ).toEqual(["first", "second", "third"]);
  });
});
