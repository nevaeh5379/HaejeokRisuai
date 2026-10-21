import { describe, expect, test } from "vitest";
import { illustrationDisplayLayout } from "./illustrationDisplay";

describe("illustrationDisplayLayout", () => {
  test("places illustration placeholders and creates valid bindings JSON", () => {
    const text = "Scene one <Illustration> and scene two {{illustration::slot-abc}} end.";
    const illustrations = [
      {
        id: "slot-abc",
        token: "{{illustration::slot-abc}}",
        status: "complete" as const,
        version: 1,
        sourceHash: "test",
        executor: "app" as const,
        runId: "run-1",
      },
    ];

    const result = illustrationDisplayLayout(text, illustrations);
    expect(result.display).toContain('<span data-risu-illustration="0"></span>');
    expect(result.display).toContain('<span data-risu-illustration="1"></span>');
    expect(result.display).not.toContain("<Illustration>");
    expect(result.display).not.toContain("{{illustration::slot-abc}}");

    const bindings = JSON.parse(result.bindings);
    expect(bindings).toEqual([{ id: "slot-abc", index: 1 }]);
  });
});
