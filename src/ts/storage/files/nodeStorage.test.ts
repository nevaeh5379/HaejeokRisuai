import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("src/lang", () => ({ language: {} }));
vi.mock("../../alert", () => ({
  alertError: vi.fn(),
  alertInput: vi.fn(),
  waitAlert: vi.fn(),
}));
vi.mock("../../util", () => ({
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

function createMemoryCacheStorage() {
  const entries = new Map<string, Response>();
  const toUrl = (request: RequestInfo | URL) =>
    typeof request === "string"
      ? request
      : request instanceof URL
        ? request.toString()
        : request.url;
  const cache = {
    match: vi.fn(async (request: RequestInfo | URL) =>
      entries.get(toUrl(request))?.clone(),
    ),
    put: vi.fn(async (request: RequestInfo | URL, response: Response) => {
      entries.set(toUrl(request), response.clone());
    }),
    delete: vi.fn(async (request: RequestInfo | URL) =>
      entries.delete(toUrl(request)),
    ),
    keys: vi.fn(async () =>
      [...entries.keys()].map((url) => new Request(url)),
    ),
  };
  return {
    cache,
    storage: { open: vi.fn(async () => cache) },
  };
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

describe("NodeStorage.getItems image cache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("requests only uncached transformed images from read-bulk", async () => {
    const { NodeStorage } = await import("./nodeStorage");
    const payload = Buffer.from("cached thumbnail");
    const protocolData = Buffer.concat([
      createHeaderPacket(0, "assets/image.png", payload.length),
      createChunkPacket(0, payload),
      createEndPacket(0),
    ]);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(protocolData, {
        headers: { "x-risu-total-files": "1" },
      }),
    );
    const memoryCache = createMemoryCacheStorage();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("caches", memoryCache.storage);

    const storage = new NodeStorage();
    vi.spyOn(storage as any, "checkAuth").mockResolvedValue(undefined);
    vi.spyOn(storage, "createAuth").mockResolvedValue("auth");

    const first = await storage.getItems(["assets/image.png"], undefined, {
      size: "display",
      width: 512,
      height: 768,
    });
    const second = await storage.getItems(["assets/image.png"], undefined, {
      size: "display",
      width: 512,
      height: 768,
    });

    expect(first.get("assets/image.png")).toEqual(payload);
    expect(second.get("assets/image.png")).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(memoryCache.cache.put).toHaveBeenCalledTimes(1);
  });

  it("invalidates every cached size after overwriting an asset", async () => {
    const { NodeStorage } = await import("./nodeStorage");
    const oldPayload = Buffer.from("old thumbnail");
    const newPayload = Buffer.from("new thumbnail");
    const bulkResponse = (payload: Buffer) =>
      new Response(
        Buffer.concat([
          createHeaderPacket(0, "assets/image.png", payload.length),
          createChunkPacket(0, payload),
          createEndPacket(0),
        ]),
        { headers: { "x-risu-total-files": "1" } },
      );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(bulkResponse(oldPayload))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(bulkResponse(newPayload));
    const memoryCache = createMemoryCacheStorage();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("caches", memoryCache.storage);

    const storage = new NodeStorage();
    vi.spyOn(storage as any, "checkAuth").mockResolvedValue(undefined);
    vi.spyOn(storage, "createAuth").mockResolvedValue("auth");
    const options = { size: "thumb" as const, width: 128, height: 128 };

    await storage.getItems(["assets/image.png"], undefined, options);
    await storage.setItem("assets/image.png", new Uint8Array([1, 2, 3]));
    const refreshed = await storage.getItems(
      ["assets/image.png"],
      undefined,
      options,
    );

    expect(refreshed.get("assets/image.png")).toEqual(newPayload);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(memoryCache.cache.delete).toHaveBeenCalled();
  });
});

describe("NodeStorage vector index requests", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends a revision-only warm status request without descriptors", async () => {
    const { NodeStorage } = await import("./nodeStorage");
    let requestBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        requestBody = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({ ready: true, missingIds: [], size: 19000 }),
          { status: 200 },
        );
      }),
    );

    const storage = new NodeStorage();
    vi.spyOn(storage as any, "getCachedAuth").mockResolvedValue("auth");
    const status = await storage.vectorIndexStatus(
      "dynamic-assets:char",
      undefined,
      "19000:revision",
    );

    expect(status.ready).toBe(true);
    expect(requestBody).toEqual({
      indexId: "dynamic-assets:char",
      revision: "19000:revision",
    });
  });

  it("forwards vector search topK to the server", async () => {
    const { NodeStorage } = await import("./nodeStorage");
    let requestBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        requestBody = JSON.parse(init.body as string);
        return new Response(JSON.stringify({ results: [[['a', 1]]] }), {
          status: 200,
        });
      }),
    );

    const storage = new NodeStorage();
    vi.spyOn(storage as any, "getCachedAuth").mockResolvedValue("auth");
    const results = await storage.vectorIndexSearch(
      "dynamic-assets:char",
      [[1, 0]],
      "dot",
      1,
    );


    expect(results).toEqual([[['a', 1]]]);
    expect(requestBody).toEqual({
      indexId: "dynamic-assets:char",
      queries: [[1, 0]],
      metric: "dot",
      topK: 1,
    });
  });
});
