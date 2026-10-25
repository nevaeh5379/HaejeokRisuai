import { describe, it, expect } from "vitest";
import {
  findAllOriginalRangesFromText,
  findAllOriginalRangesFromHtml,
  replaceRange,
  type RangeResult,
} from "./partialEdit";

describe("partialEdit parser and matcher", () => {
  it("finds exact matches with exact character ranges", () => {
    const md = "Hello world! This is a test sentence for editing.";
    const plain = "This is a test sentence";
    const results = findAllOriginalRangesFromText(md, plain);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].method).toBe("exact");
    expect(results[0].confidence).toBe(1.0);
    expect(md.slice(results[0].start, results[0].end)).toBe(plain);
    expect(results[0].lineNumber).toBe(1);
  });

  it("handles ruby patterns and CBS normalization mapping", () => {
    const md = "Hello {{ruby::漢字::かんじ}} world!";
    const plain = "漢字(かんじ)";
    const results = findAllOriginalRangesFromText(md, plain);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].method).toBe("exact");
    // Range maps back to the CBS syntax in original markdown
    expect(md.slice(results[0].start, results[0].end)).toBe(
      "{{ruby::漢字::かんじ}}",
    );
  });

  it("normalizes typographic quotes and dashes", () => {
    const md = "“Hello world” – said the noble lady.";
    const plain = '"Hello world" - said the noble lady.';
    const results = findAllOriginalRangesFromText(md, plain);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].confidence).toBeGreaterThan(0.9);
  });

  it("performs anchor matching when exact match is missing", () => {
    const md =
      "Once upon a time in a faraway kingdom with flowers and bright stars shining above.";
    const plain =
      "Once upon a time in an ancient faraway realm with flowers and bright stars shining above.";
    const results = findAllOriginalRangesFromText(md, plain, { anchor: 15 });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].method).toBe("anchor");
  });

  it("correctly replaces matched range with replaceRange", () => {
    const original = "The quick brown fox jumps over the lazy dog.";
    const range: RangeResult = {
      start: 4,
      end: 19,
      method: "exact",
      confidence: 1.0,
    };
    const replaced = replaceRange(original, range, "graceful noble cat");
    expect(replaced).toBe("The graceful noble cat jumps over the lazy dog.");
  });

  it("converts HTML elements and ruby tags correctly in findAllOriginalRangesFromHtml", () => {
    const md = "Hello world! Beautiful sunny day.";
    const html = "<p>Beautiful sunny day.</p>";
    const results = findAllOriginalRangesFromHtml(md, html);

    expect(results.length).toBeGreaterThan(0);
    expect(md.slice(results[0].start, results[0].end)).toBe(
      "Beautiful sunny day.",
    );
  });

  it("returns empty array for empty inputs", () => {
    expect(findAllOriginalRangesFromText("", "something")).toEqual([]);
    expect(findAllOriginalRangesFromText("something", "")).toEqual([]);
    expect(findAllOriginalRangesFromHtml("something", "")).toEqual([]);
  });
});
