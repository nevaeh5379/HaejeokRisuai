import { describe, expect, it } from "vitest";
import { AllCBS, simpleCBSHighlightParser } from "./highlight";

describe("simpleCBSHighlightParser", () => {
  it("parses normal CBS tags correctly", () => {
    const text = "Hello {{char}} and {{user}}!";
    const result = simpleCBSHighlightParser(text);
    expect(result).toHaveLength(2);
    expect(result[0][1]).toBe("cbsnest1");
    expect(result[1][1]).toBe("cbsnest1");
  });

  it("parses parameterized CBS tags with O(1) prefix lookup", () => {
    const text = "{{getvar::my_var}} and {{setvar::score::10}}";
    const result = simpleCBSHighlightParser(text);
    expect(result).toHaveLength(2);
    expect(result[0][1]).toBe("cbsnest1");
    expect(result[1][1]).toBe("cbsnest1");
  });

  it("parses display related CBS tags correctly", () => {
    const text = "{{img::cute_cat.png}} {{emotion::happy}}";
    const result = simpleCBSHighlightParser(text);
    expect(result).toHaveLength(2);
    expect(result[0][1]).toBe("cbsdisplay");
    expect(result[1][1]).toBe("cbsdisplay");
  });

  it("parses deprecated CBS tags and deprecated parameters", () => {
    const text = "{{personality}} {{remaind::5::2}}";
    const result = simpleCBSHighlightParser(text);
    expect(result).toHaveLength(2);
    expect(result[0][1]).toBe("deprecated");
    expect(result[1][1]).toBe("deprecated");
  });

  it("parses comment CBS tags", () => {
    const text = "{{// this is a comment}}";
    const result = simpleCBSHighlightParser(text);
    expect(result).toHaveLength(1);
    expect(result[0][1]).toBe("comment");
  });

  it("parses special CBS tags like random and nested if", () => {
    const text = "{{random: apple, banana}} {{#if true}}hello{{/if}}";
    const result = simpleCBSHighlightParser(text);
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0][1]).toBe("cbsnest1");
  });

  it("handles nested CBS tags with cyclic depth classes", () => {
    const text = "{{getvar::{{slot}}}}";
    const result = simpleCBSHighlightParser(text);
    expect(result.length).toBe(3);
  });

  it("maintains AllCBS as a populated frozen array with colon suffixes", () => {
    expect(AllCBS.length).toBeGreaterThan(50);
    expect(Object.isFrozen(AllCBS)).toBe(true);
    expect(AllCBS).toContain("char");
    expect(AllCBS).toContain("getvar:");
    expect(AllCBS).toContain("img:");
    expect(AllCBS).toContain("#if");
  });
});
