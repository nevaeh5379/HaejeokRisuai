import { createRequire } from "node:module";
import { once } from "node:events";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createJsonStream, stringifyJsonChunks } = require("./streamJson.cjs");

async function readStream(value: unknown, chunkBytes = 16): Promise<string> {
  const stream = createJsonStream(value, { chunkBytes });
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer | string) =>
    chunks.push(Buffer.from(chunk)),
  );
  await once(stream, "end");
  return Buffer.concat(chunks).toString("utf8");
}

describe("streaming JSON serializer", () => {
  it("matches JSON.stringify for nested database-shaped values", async () => {
    const value = {
      revision: 42,
      database: {
        characters: [{ id: "한글-id", chats: [{ message: ["a", null, 3.5] }] }],
        flags: { enabled: true, missing: undefined, invalid: Number.NaN },
      },
    };
    expect(await readStream(value)).toBe(JSON.stringify(value));
  });

  it("uses JSON array semantics for unsupported values", async () => {
    const value = [undefined, () => null, Symbol("x"), { omitted: undefined }];
    expect(await readStream(value)).toBe(JSON.stringify(value));
  });

  it("emits multiple bounded batches for many small values", () => {
    const chunks = [
      ...stringifyJsonChunks(
        Array.from({ length: 100 }, (_, i) => i),
        32,
      ),
    ];
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(
      JSON.stringify(Array.from({ length: 100 }, (_, i) => i)),
    );
  });

  it("rejects circular values like JSON.stringify", async () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    await expect(readStream(value)).rejects.toThrow(/circular/i);
  });
});
