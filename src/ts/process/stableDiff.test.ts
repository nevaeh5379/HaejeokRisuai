import { describe, expect, test, vi } from "vitest";

vi.mock("../alert", () => ({ alertError: vi.fn() }));
vi.mock("../globalApi.svelte", () => ({
  globalFetch: vi.fn(),
  readImage: vi.fn(),
}));
vi.mock(
  import("@risuai/protocol/src/imageGeneration.ts"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    executeImageGeneration: vi.fn(async () => "data:image/png;base64,AAA"),
  }),
);
vi.mock("./imageGenerationBrowser", () => ({
  browserImageRuntime: {},
  getImageGenerationSettings: () => ({
    sdProvider: "novelai",
    NAIImgConfig: { width: 1024, height: 640 },
  }),
}));
import { executeImageGeneration } from "@risuai/protocol/src/imageGeneration.ts";
import { applyImageOrientation, generateAIImage } from "./stableDiff";

describe("applyImageOrientation", () => {
  test("keeps configured dimensions without an orientation", () => {
    expect(applyImageOrientation(1024, 640)).toEqual({
      height: 640,
      width: 1024,
    });
  });

  test("places the longer edge on the width for landscape", () => {
    expect(applyImageOrientation(640, 1024, "landscape")).toEqual({
      height: 640,
      width: 1024,
    });
  });

  test("places the longer edge on the height for portrait", () => {
    expect(applyImageOrientation(1024, 640, "portrait")).toEqual({
      height: 1024,
      width: 640,
    });
  });
});

test("sends the Lua orientation to the shared NovelAI image core", async () => {
  await generateAIImage(
    "prompt",
    { type: "character" } as never,
    "negative",
    "inlay",
    { orientation: "portrait" },
  );
  expect(executeImageGeneration).toHaveBeenCalledWith(
    expect.objectContaining({ NAIImgConfig: { width: 640, height: 1024 } }),
    expect.anything(),
    "prompt",
    expect.anything(),
    "negative",
  );
});
