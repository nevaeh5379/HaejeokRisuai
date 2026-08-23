import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("src/lang", () => ({ language: {} }));
vi.mock("../alert", () => ({
  alertError: vi.fn(),
  alertInput: vi.fn(),
  waitAlert: vi.fn(),
}));
vi.mock("../util", () => ({
  base64url: vi.fn(),
  getKeypairStore: vi.fn(),
  saveKeypairStore: vi.fn(),
}));

function createHeaderPacket(
  fileId: number,
  name: string,
  size: number,
): Buffer {
  const encodedName = Buffer.from(name, "utf8");
  const packet = Buffer.alloc(1 + 4 + 4 + encodedName.length + 8);
  packet.writeUInt8(0x01, 0);
  packet.writeUInt32BE(fileId, 1);
  packet.writeUInt32BE(encodedName.length, 5);
  encodedName.copy(packet, 9);
  packet.writeBigUInt64BE(BigInt(size), 9 + encodedName.length);
  return packet;
}

function createChunkPacket(fileId: number, data: Uint8Array): Buffer {
  const packet = Buffer.alloc(1 + 4 + 4 + data.byteLength);
  packet.writeUInt8(0x02, 0);
  packet.writeUInt32BE(fileId, 1);
  packet.writeUInt32BE(data.byteLength, 5);
  Buffer.from(data).copy(packet, 9);
  return packet;
}

function createEndPacket(fileId: number): Buffer {
  const packet = Buffer.alloc(5);
  packet.writeUInt8(0x03, 0);
  packet.writeUInt32BE(fileId, 1);
  return packet;
}

describe("NodeStorage.streamItems", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("forwards fragmented response data in file order", async () => {
    const { NodeStorage } = await import("./nodeStorage");
    const first = Buffer.from("first file");
    const second = Buffer.from("second");
    const protocolData = Buffer.concat([
      createHeaderPacket(0, "assets/first.png", first.length),
      createChunkPacket(0, first.subarray(0, 3)),
      createChunkPacket(0, first.subarray(3)),
      createEndPacket(0),
      createHeaderPacket(1, "assets/second.png", second.length),
      createChunkPacket(1, second),
      createEndPacket(1),
    ]);
    const networkChunks = [
      protocolData.subarray(0, 2),
      protocolData.subarray(2, 19),
      protocolData.subarray(19, 41),
      protocolData.subarray(41),
    ];
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of networkChunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(responseBody)),
    );

    const storage = new NodeStorage();
    vi.spyOn(storage as any, "checkAuth").mockResolvedValue(undefined);
    vi.spyOn(storage, "createAuth").mockResolvedValue("auth");

    const events: string[] = [];
    const received = new Map<string, Buffer[]>();
    await storage.streamItems(["assets/first.png", "assets/second.png"], {
      onFileStart(name) {
        events.push(`start:${name}`);
        received.set(name, []);
      },
      async onFileChunk(name, chunk) {
        await Promise.resolve();
        events.push(`chunk:${name}`);
        received.get(name)?.push(Buffer.from(chunk));
      },
      onFileEnd(name) {
        events.push(`end:${name}`);
      },
    });

    expect(Buffer.concat(received.get("assets/first.png") ?? [])).toEqual(
      first,
    );
    expect(Buffer.concat(received.get("assets/second.png") ?? [])).toEqual(
      second,
    );
    expect(events[0]).toBe("start:assets/first.png");
    expect(events.at(-1)).toBe("end:assets/second.png");
    expect(events.indexOf("end:assets/first.png")).toBeLessThan(
      events.indexOf("start:assets/second.png"),
    );
  });

  it("streams a server-resolved prefix without sending a large key array", async () => {
    const { NodeStorage } = await import("./nodeStorage");
    const payload = Buffer.from("asset");
    const protocolData = Buffer.concat([
      createHeaderPacket(0, "assets/prefix.png", payload.length),
      createChunkPacket(0, payload),
      createEndPacket(0),
    ]);
    let requestBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        requestBody = JSON.parse(init.body as string);
        return new Response(protocolData, {
          headers: {
            "x-risu-total-files": "1",
            "x-risu-asset-list-source": "catalog",
          },
        });
      }),
    );

    const storage = new NodeStorage();
    vi.spyOn(storage as any, "checkAuth").mockResolvedValue(undefined);
    vi.spyOn(storage, "createAuth").mockResolvedValue("auth");
    const progress: any[] = [];

    await storage.streamItems(
      [],
      {
        onFileStart: vi.fn(),
        onFileChunk: vi.fn(),
      },
      (event) => progress.push(event),
      { prefix: "assets/" },
    );

    expect(requestBody).toMatchObject({ prefix: "assets/", thumb: false });
    expect(requestBody).not.toHaveProperty("filePaths");
    expect(progress[0]).toMatchObject({
      totalFiles: 1,
      assetListSource: "catalog",
    });
  });
});
