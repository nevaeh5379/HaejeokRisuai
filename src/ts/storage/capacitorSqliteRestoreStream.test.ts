import { describe, expect, it } from "vitest";
import { Buffer } from "buffer";
import { CapacitorSqliteRestoreStream } from "./capacitorSqliteRestoreStream";

describe("CapacitorSqliteRestoreStream", () => {
  it("streams large string binds through bounded bridge chunks", async () => {
    const chunks: string[] = [];
    let parsed: Array<{ sql: string; bind: unknown[] }> = [];
    const plugin = {
      restoreOpen: async () => ({ id: "restore-1" }),
      restoreAppend: async ({ data }: { id: string; data: string }) => {
        chunks.push(data);
      },
      restoreFinish: async () => {
        const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, "base64")));
        parsed = JSON.parse(bytes.toString("utf8"));
        return { statements: parsed.length };
      },
      restoreAbort: async () => {},
      addListener: async () => ({ remove: async () => {} }),
    };

    const stream = new CapacitorSqliteRestoreStream(plugin as any);
    const huge = `${"A\\\"\n".repeat(300_000)}😀끝`;
    const statementProgress: number[] = [];
    await stream.open(7);
    await stream.writeStatement(
      "INSERT INTO test(value) VALUES (?)",
      [huge],
      (fraction) => statementProgress.push(fraction),
    );
    await stream.writeStatement("UPDATE test SET n = ?", [42]);
    const count = await stream.finish();

    expect(count).toBe(2);
    expect(parsed[0].sql).toBe("INSERT INTO test(value) VALUES (?)");
    expect(parsed[0].bind[0]).toBe(huge);
    expect(parsed[1].bind).toEqual([42]);
    expect(statementProgress.length).toBeGreaterThan(10);
    expect(statementProgress.some((fraction) => fraction > 0 && fraction < 1)).toBe(true);
    expect(statementProgress.at(-1)).toBe(1);
    for (let index = 1; index < statementProgress.length; index++) {
      expect(statementProgress[index]).toBeGreaterThanOrEqual(
        statementProgress[index - 1],
      );
    }
    expect(chunks.length).toBeGreaterThan(10);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThan(256 * 1024);
  });
});
