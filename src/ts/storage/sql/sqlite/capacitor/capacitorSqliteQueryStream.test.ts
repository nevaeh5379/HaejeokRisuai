import { Buffer } from "buffer";
import { describe, expect, it, vi } from "vitest";
import { readSqliteQueryStream } from "./capacitorSqliteQueryStream";
import type { NativeSqlitePlugin } from "./capacitorNativeSqlite";

function bridge(text: string, chunkSize = 7) {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  const plugin = {
    queryStreamOpen: vi.fn(async () => ({ id: "query-1" })),
    queryStreamRead: vi.fn(async () => {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      offset += chunk.length;
      return { data: chunk.toString("base64"), done: chunk.length === 0 };
    }),
    queryStreamClose: vi.fn(async () => {}),
  };
  return plugin;
}

const query = { sql: "SELECT value", bind: [] };
const end = (queryIndex: number) =>
  JSON.stringify({ type: "end", queryIndex }) + "\n";
const row = (queryIndex: number, value: Record<string, unknown>) =>
  JSON.stringify({ type: "row", queryIndex, row: value }) + "\n";

describe("SQLite query stream", () => {
  it("preserves empty sets, row order and Unicode across byte and line boundaries", async () => {
    const value = {
      text: '한글😀\n\\"\u0000\ud800',
      blob: [0, 128, 255],
      n: null,
    };
    for (const chunkSize of [1, 7, 32, 192 * 1024]) {
      const plugin = bridge(
        end(0) + row(1, value) + row(1, { text: "last" }) + end(1),
        chunkSize,
      );
      await expect(
        readSqliteQueryStream(plugin as unknown as NativeSqlitePlugin, [
          query,
          query,
        ]),
      ).resolves.toEqual([[], [value, { text: "last" }]]);
      expect(plugin.queryStreamClose).toHaveBeenCalledOnce();
    }
  });

  it("parses a multi-megabyte row without treating transport chunks as rows", async () => {
    const value = { text: 'A\\"\n😀'.repeat(300_000) };
    const plugin = bridge(row(0, value) + end(0), 192 * 1024);
    await expect(
      readSqliteQueryStream(plugin as unknown as NativeSqlitePlugin, [query]),
    ).resolves.toEqual([[value]]);
    expect(plugin.queryStreamRead.mock.calls.length).toBeGreaterThan(10);
  });

  it.each([
    row(0, { n: 1 }),
    row(0, { n: 1 }) + '{"type":"end"',
    end(1),
    end(0) + row(0, { n: 1 }),
    '{"type":"row","queryIndex":0,"row":[]}\n' + end(0),
    "invalid\n",
  ])(
    "rejects malformed or incomplete streams and closes the session",
    async (text) => {
      const plugin = bridge(text);
      await expect(
        readSqliteQueryStream(plugin as unknown as NativeSqlitePlugin, [query]),
      ).rejects.toThrow();
      expect(plugin.queryStreamClose).toHaveBeenCalledOnce();
    },
  );

  it("does not return partial results when the producer fails after emitting rows", async () => {
    const plugin = bridge(row(0, { n: 1 }), 192 * 1024);
    plugin.queryStreamRead.mockImplementationOnce(async () => ({
      data: Buffer.from(row(0, { n: 1 })).toString("base64"),
      done: false,
    }));
    plugin.queryStreamRead.mockRejectedValueOnce(new Error("SQL failure"));
    plugin.queryStreamClose.mockRejectedValueOnce(new Error("close failure"));
    await expect(
      readSqliteQueryStream(plugin as unknown as NativeSqlitePlugin, [query]),
    ).rejects.toThrow("SQL failure");
    expect(plugin.queryStreamClose).toHaveBeenCalledOnce();
  });

  it("rejects invalid UTF-8 and oversized bridge chunks", async () => {
    for (const data of [
      Buffer.from([0xff]).toString("base64"),
      "A".repeat(256 * 1024 + 4),
    ]) {
      const plugin = bridge("");
      plugin.queryStreamRead.mockResolvedValueOnce({ data, done: true });
      await expect(
        readSqliteQueryStream(plugin as unknown as NativeSqlitePlugin, [query]),
      ).rejects.toThrow();
      expect(plugin.queryStreamClose).toHaveBeenCalledOnce();
    }
  });

  it("does not open a native session for an empty query list", async () => {
    const plugin = bridge("");
    await expect(
      readSqliteQueryStream(plugin as unknown as NativeSqlitePlugin, []),
    ).resolves.toEqual([]);
    expect(plugin.queryStreamOpen).not.toHaveBeenCalled();
  });

  it("rejects a nonterminal empty chunk instead of looping forever", async () => {
    const plugin = bridge("");
    plugin.queryStreamRead.mockResolvedValueOnce({ data: "", done: false });
    await expect(
      readSqliteQueryStream(plugin as unknown as NativeSqlitePlugin, [query]),
    ).rejects.toThrow("no progress");
    expect(plugin.queryStreamClose).toHaveBeenCalledOnce();
  });
});
