import { expect, it } from "vitest";
import { readStreamLines } from "./readStreamLines";

it("preserves UTF-8 across chunks and yields every complete record in order", async () => {
  const bytes = new TextEncoder().encode('한글\n\n{"type":"done"}\n');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 1));
      controller.enqueue(bytes.subarray(1, 5));
      controller.enqueue(bytes.subarray(5));
      controller.close();
    },
  });
  const lines: string[] = [];
  for await (const line of readStreamLines(stream.getReader())) {
    lines.push(line);
  }
  expect(lines).toEqual(["한글", "", '{"type":"done"}']);
});
