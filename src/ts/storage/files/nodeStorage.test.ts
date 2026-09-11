import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("src/lang", () => ({ language: {} }));
vi.mock("../../alert", () => ({
  alertError: vi.fn(),
  alertInput: vi.fn(),
  waitAlert: vi.fn(),
}));

function markAuthFresh(storage: {
  authChecked: boolean;
  authValidatedAt?: number;
}) {
  storage.authChecked = true;
  storage.authValidatedAt = Date.now();
}

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
    keys: vi.fn(async () => [...entries.keys()].map((url) => new Request(url))),
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
    markAuthFresh(storage as any);
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
    markAuthFresh(storage as any);
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

describe("NodeStorage password connection", () => {
  it("accepts an explicitly empty password and hashes it before setup", async () => {
    const { NodeStorage } = await import("./nodeStorage");
    const { NodeApiClient } = await import("../runtime/nodeApiClient");
    const digest =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          apiVersion: 1,
          features: {
            sqlStorage: true,
            assetStorage: true,
            dataChangeEvents: true,
            storageSync: true,
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ status: "unset" }))
      .mockResolvedValueOnce(new Response(digest))
      .mockResolvedValueOnce(Response.json({ status: "success" }));
    const client = new NodeApiClient(
      {
        version: 1,
        mode: "remote",
        baseUrl: "https://sync.example",
        allowInsecureHttp: false,
      },
      fetcher,
    );
    const storage = new NodeStorage(client);
    vi.spyOn(storage, "createAuth").mockResolvedValue("test-auth");
    const authorize = vi
      .spyOn((storage as any).authController, "authorizeKey")
      .mockResolvedValue(undefined);

    await expect(storage.connectWithPassword("")).resolves.toBeUndefined();
    expect(JSON.parse(fetcher.mock.calls[3][1]?.body as string)).toEqual({
      password: digest,
    });
    expect(authorize).toHaveBeenCalledWith(digest);
  });
});

describe("NodeStorage auth revalidation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("revalidates a stale registered key before issuing direct asset URLs", async () => {
    const { NodeStorage } = await import("./nodeStorage");
    const { NodeApiClient } = await import("../runtime/nodeApiClient");
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ status: "success" }),
    );
    const storage = new NodeStorage(
      new NodeApiClient(
        {
          version: 1,
          mode: "remote",
          baseUrl: "https://sync.example",
          allowInsecureHttp: false,
        },
        fetcher,
      ),
    );
    storage.authChecked = true;
    (storage as any).authValidatedAt = Date.now() - 61_000;
    vi.spyOn(storage, "createAuth").mockResolvedValue("fresh-auth");

    const first = await storage.getDirectUrl("assets/a.png");
    const second = await storage.getDirectUrl("assets/b.png");

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toContain("/api/test_auth");
    expect(first).toContain("auth=fresh-auth");
    expect(second).toContain("auth=fresh-auth");
  });

  it("shares one signed token across concurrent SQL requests", async () => {
    const { NodeStorage } = await import("./nodeStorage");
    const storage = new NodeStorage();
    markAuthFresh(storage as any);
    const createAuth = vi
      .spyOn(storage, "createAuth")
      .mockImplementation(async () => {
        await Promise.resolve();
        return "shared-auth";
      });
    const getSqlAuth = (storage.sql as any).getAuth as () => Promise<string>;

    const tokens = await Promise.all([
      getSqlAuth(),
      getSqlAuth(),
      getSqlAuth(),
      getSqlAuth(),
    ]);

    expect(tokens).toEqual(Array(4).fill("shared-auth"));
    expect(createAuth).toHaveBeenCalledTimes(1);
  });
});

describe("NodeStorage authentication identity", () => {
  it("uses a separate key-pair namespace for each server origin", async () => {
    const { remoteAuthKeyStoreName } =
      await import("@risuai/storage-remote/remoteAuthIdentity");
    expect(remoteAuthKeyStoreName("https://one.example")).toBe(
      "node:aHR0cHM6Ly9vbmUuZXhhbXBsZQ",
    );
    expect(remoteAuthKeyStoreName("https://two.example")).toBe(
      "node:aHR0cHM6Ly90d28uZXhhbXBsZQ",
    );
  });

  it("loads one key pair for concurrent signing requests", async () => {
    const { RemoteAuthIdentity } =
      await import("@risuai/storage-remote/remoteAuthIdentity");
    const keyPair = {
      privateKey: { type: "private" },
      publicKey: { type: "public" },
    } as unknown as CryptoKeyPair;
    const loadKeyPair = vi.fn(async () => {
      await Promise.resolve();
      return keyPair;
    });
    const identity = new RemoteAuthIdentity(
      { baseUrl: "https://sync.example" } as any,
      loadKeyPair,
      vi.fn(),
    );

    const pairs = await Promise.all([
      identity.getKeyPair(),
      identity.getKeyPair(),
      identity.getKeyPair(),
    ]);

    expect(pairs).toEqual([keyPair, keyPair, keyPair]);
    expect(loadKeyPair).toHaveBeenCalledTimes(1);
  });
});

describe("NodeStorage native asset reads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves server MIME metadata and transformed query options", async () => {
    const { NodeStorage } = await import("./nodeStorage");
    const { NodeApiClient } = await import("../runtime/nodeApiClient");
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/api/read");
        expect(url.searchParams.get("size")).toBe("display");
        expect(url.searchParams.get("width")).toBe("512");
        expect(url.searchParams.get("height")).toBe("768");
        expect(url.search.startsWith("??")).toBe(false);
        const headers = new Headers(init?.headers);
        expect(headers.get("risu-auth")).toBe("native-auth");
        expect(headers.get("file-path")).toBe(
          Buffer.from("assets/avatar.png", "utf8").toString("hex"),
        );
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/webp; charset=binary" },
        });
      },
    );
    const storage = new NodeStorage(
      new NodeApiClient(
        {
          version: 1,
          mode: "remote",
          baseUrl: "https://sync.example",
          allowInsecureHttp: false,
        },
        fetcher,
      ),
    );
    markAuthFresh(storage as any);
    vi.spyOn(storage, "createAuth").mockResolvedValue("native-auth");

    const item = await storage.getItemWithMetadata("assets/avatar.png", {
      size: "display",
      width: 512,
      height: 768,
    });

    expect(item?.data).toEqual(Buffer.from([1, 2, 3]));
    expect(item?.contentType).toBe("image/webp");
    expect(fetcher).toHaveBeenCalledTimes(1);
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
    markAuthFresh(storage as any);
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
    markAuthFresh(storage as any);
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

describe("NodeStorage storage sync asset reader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reuses asset metadata and reads bounded HTTP ranges", async () => {
    const { NodeStorage } = await import("./nodeStorage");
    const { NodeApiClient } = await import("../runtime/nodeApiClient");
    const payload = new Uint8Array([12, 13, 14]);
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        expect(url).toContain("/api/read?path=");
        expect(new Headers(init?.headers).get("range")).toBe("bytes=2-4");
        expect(new Headers(init?.headers).get("risu-auth")).toBe("sync-auth");
        return new Response(payload, {
          status: 206,
          headers: {
            "content-range": "bytes 2-4/6",
            "content-length": "3",
          },
        });
      },
    );
    const client = new NodeApiClient(
      {
        version: 1,
        mode: "remote",
        baseUrl: "https://sync.example",
        allowInsecureHttp: false,
      },
      fetcher,
    );
    const storage = new NodeStorage(client);
    vi.spyOn(storage as any, "getCachedAuth").mockResolvedValue("sync-auth");
    const details = vi.spyOn(storage.s3, "getAssetDetails").mockResolvedValue({
      storageType: "fs",
      totalObjects: 3,
      totalSizeBytes: 14,
      assets: [
        { key: "assets/z.bin", size: 6, mtime: 1 },
        { key: "other.bin", size: 3, mtime: 1 },
        { key: "assets/a.bin", size: 5, mtime: 1 },
      ],
    });

    await expect(storage.listSyncAssetKeys("assets/")).resolves.toEqual([
      "assets/a.bin",
      "assets/z.bin",
    ]);
    await expect(storage.getSyncAssetSize("assets/z.bin")).resolves.toBe(6);
    await expect(
      storage.readSyncAssetChunk("assets/z.bin", 2, 3),
    ).resolves.toEqual(payload);
    expect(details).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
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
        return new Response(JSON.stringify({ results: [[["a", 1]]] }), {
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

    expect(results).toEqual([[["a", 1]]]);
    expect(requestBody).toEqual({
      indexId: "dynamic-assets:char",
      queries: [[1, 0]],
      metric: "dot",
      topK: 1,
    });
  });
});
