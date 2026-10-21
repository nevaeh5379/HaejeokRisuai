import { describe, expect, it, vi } from "vitest";
import { restoreUpstreamPluginStorage } from "./upstreamPluginStorage.ts";

describe("upstream cold plugin storage import", () => {
  it("restores index values, large payloads and legacy values with upstream precedence", async () => {
    const cold = new Map<string, unknown>([
      [
        "index",
        {
          type: "risu-plugin-storage-index",
          entries: [
            { k: "small", s: "false" },
            { k: "large", l: "payload" },
            { k: "override", s: '"old"' },
            { k: "empty", s: '""' },
            { k: "zero", s: "0" },
            { k: "null", s: "null" },
            { k: "__proto__", s: '{"safe":true}' },
          ],
          trash: [{ id: "deleted", at: 0 }],
        },
      ],
      ["payload", { text: "큰 값" }],
      ["legacy", [1, 2]],
    ]);
    const read = vi.fn(async (key: string) => cold.get(key));
    const restored = await restoreUpstreamPluginStorage(
      {
        _coldpluginIndex: "index",
        _coldplugin: { legacy: "legacy", small: "outdated" },
        override: "new",
      },
      read,
    );
    expect(restored).toEqual({
      small: false,
      large: { text: "큰 값" },
      override: "new",
      empty: "",
      zero: 0,
      null: null,
      legacy: [1, 2],
      ["__proto__"]: { safe: true },
    });
    expect(read.mock.calls.flat()).not.toContain("deleted");
    expect(read.mock.calls.flat()).not.toContain("outdated");
  });
  it("rejects a missing index or large value instead of replacing it with empty storage", async () => {
    await expect(
      restoreUpstreamPluginStorage(
        { _coldpluginIndex: "missing" },
        async () => undefined,
      ),
    ).rejects.toThrow("index");
    await expect(
      restoreUpstreamPluginStorage({ _coldpluginIndex: "index" }, async (id) =>
        id === "index"
          ? {
              type: "risu-plugin-storage-index",
              entries: [{ k: "large", l: "missing" }],
            }
          : undefined,
      ),
    ).rejects.toThrow("Missing upstream plugin storage value");
  });
});
