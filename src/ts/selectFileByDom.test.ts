import { afterEach, describe, expect, it, vi } from "vitest";
import { selectFileByDom } from "./util";

function installFileInputSpy() {
  const original = document.createElement.bind(document);
  let input: HTMLInputElement | null = null;
  vi.spyOn(document, "createElement").mockImplementation(
    (tag: string, options?: ElementCreationOptions) => {
      const element = original(tag, options);
      if (tag.toLowerCase() === "input") {
        input = element as HTMLInputElement;
      }
      return element;
    },
  );
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
  return () => input;
}

function chooseFiles(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, "files", {
    value: files,
    configurable: true,
  });
  input.dispatchEvent(new Event("change"));
}

const PRESET_EXTENSIONS = ["json", "preset", "risupreset", "risup"];

describe("selectFileByDom", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns files that match an allow-listed extension", async () => {
    const getInput = installFileInputSpy();
    const promise = selectFileByDom(PRESET_EXTENSIONS, "single");
    const file = new File([new Uint8Array([1, 2, 3])], "preset.risup");
    chooseFiles(getInput()!, [file]);

    const result = await promise;

    expect(result).toHaveLength(1);
    expect(result?.[0].name).toBe("preset.risup");
  });

  it("keeps the selection when Android drops unknown extensions from the name", async () => {
    const getInput = installFileInputSpy();
    const promise = selectFileByDom(PRESET_EXTENSIONS, "single");
    const file = new File(
      [new Uint8Array([1, 2, 3])],
      "preset_without_extension",
    );
    chooseFiles(getInput()!, [file]);

    const result = await promise;

    expect(result).toHaveLength(1);
    expect(result?.[0].name).toBe("preset_without_extension");
  });

  it("still filters out mismatched files when the accept filter is usable", async () => {
    const getInput = installFileInputSpy();
    const promise = selectFileByDom(["png"], "single");
    const file = new File([new Uint8Array([1, 2, 3])], "notes.txt");
    chooseFiles(getInput()!, [file]);

    const result = await promise;

    expect(result).toHaveLength(0);
  });
});
