import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { Packet } from "./packet.js";

test("bulk packets retain their wire format", () => {
  expect(
    Packet.createHeader(0x01020304, "é", 0x01020304050607).toString("hex"),
  ).toBe("010102030400000002c3a90001020304050607");
  expect(
    Packet.createChunk(0x01020304, Buffer.from([0xaa, 0xbb])).toString("hex"),
  ).toBe("020102030400000002aabb");
  expect(Packet.createEnd(0x01020304).toString("hex")).toBe("0301020304");
});

test("Packet.write waits for drain when the output applies backpressure", async () => {
  const output: PassThrough = new PassThrough({ highWaterMark: 1 });
  let finished: boolean = false;
  const writing: Promise<void> = Packet.write(output, Buffer.from([0xaa]));
  void writing.then(() => {
    finished = true;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(finished).toBe(false);
  expect(output.read()).toEqual(Buffer.from([0xaa]));
  await writing;
  expect(finished).toBe(true);
  output.destroy();
});
