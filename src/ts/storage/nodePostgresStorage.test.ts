import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSqlVendorParams,
  isSqlVendorParamsComplete,
  NodePostgresStorage,
} from "./nodePostgresStorage";

describe("SQL vendor form normalization", () => {
  it("normalizes provider fields without duplicating form logic", () => {
    expect(
      buildSqlVendorParams("oracle", {
        user: " risu ",
        password: "secret",
        tnsAlias: " db_high ",
        walletPath: " ",
        poolMax: 12,
      }),
    ).toEqual({
      user: "risu",
      password: "secret",
      tnsAlias: "db_high",
      walletPath: undefined,
      walletPassword: undefined,
      poolMax: 12,
    });
  });

  it("checks only the fields required by each provider", () => {
    expect(
      isSqlVendorParamsComplete("postgres", {
        connectionString: "postgres://localhost/risu",
        poolMax: 10,
      }),
    ).toBe(true);
    expect(
      isSqlVendorParamsComplete("azure", {
        server: "server",
        database: "database",
        user: "user",
        password: "",
        poolMax: 10,
      }),
    ).toBe(false);
  });
});

describe("NodePostgresStorage browser client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches server config and respects the managedByEnvironment flag", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        enabled: true,
        configured: true,
        managedByEnvironment: true,
        connectionDisplay: "postgresql://localhost/risuai",
        poolMax: 10,
        revision: 42,
        initialized: true,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const storage = new NodePostgresStorage(async () => "test-auth");
    const config = await storage.getServerConfig();

    expect(config).toEqual({
      enabled: true,
      configured: true,
      managedByEnvironment: true,
      connectionDisplay: "postgresql://localhost/risuai",
      poolMax: 10,
      revision: 42,
      initialized: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/postgres-config",
      expect.objectContaining({
        headers: expect.objectContaining({
          "risu-auth": "test-auth",
        }),
      }),
    );
  });

  it("keeps SQL disabled in the browser while the server is in recovery mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        enabled: true,
        configured: true,
        managedByEnvironment: false,
        vendor: "postgres",
        params: { connectionString: "postgresql://db/risuai", poolMax: 10 },
        storedVendor: "postgres",
        revision: null,
        initialized: false,
        runtime: {
          status: "degraded",
          vendor: "postgres",
          error: { code: "28P01", message: "authentication failed" },
          attemptStartedAt: "2026-08-24T00:00:00.000Z",
          readyAt: null,
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const storage = new NodePostgresStorage(async () => "test-auth");

    await expect(storage.init()).resolves.toBe(false);
    expect(storage.isEnabled()).toBe(false);
  });

  it("retries the configured SQL connection through the recovery endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        success: true,
        enabled: true,
        configured: true,
        managedByEnvironment: false,
        vendor: "postgres",
        params: { connectionString: "postgresql://db/risuai", poolMax: 10 },
        storedVendor: "postgres",
        revision: 7,
        initialized: true,
        runtime: { status: "ready", vendor: "postgres", error: null },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const storage = new NodePostgresStorage(async () => "test-auth");
    const result = await storage.retryDatabaseConnection();

    expect(result.runtime?.status).toBe("ready");
    expect(storage.isEnabled()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/db-config/retry",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("submits updated connection options and normalizes pool size", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        enabled: true,
        configured: true,
        managedByEnvironment: false,
        connectionDisplay: "postgresql://remote/risuai",
        poolMax: 15,
        revision: null,
        initialized: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const storage = new NodePostgresStorage(async () => "test-auth");
    const updated = await storage.configureServer({
      enabled: true,
      connectionString: "postgresql://user:pass@remote/risuai",
      poolMax: 15,
    });

    expect(updated.connectionDisplay).toBe("postgresql://remote/risuai");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/postgres-config",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          enabled: true,
          connectionString: "postgresql://user:pass@remote/risuai",
          poolMax: 15,
        }),
      }),
    );
  });

  it("does not request database.bin migration for a normal SQL config change", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          enabled: true,
          configured: true,
          runtime: { status: "ready", vendor: "postgres", error: null },
          params: { connectionString: "postgresql://remote/risuai", poolMax: 10 },
          storedVendor: "postgres",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const storage = new NodePostgresStorage(async () => "test-auth");
    await storage.applyDatabaseConfig("postgres", {
      connectionString: "postgresql://user:pass@remote/risuai",
      poolMax: 10,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/db-config",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          vendor: "postgres",
          params: {
            connectionString: "postgresql://user:pass@remote/risuai",
            poolMax: 10,
          },
          migrate: false,
        }),
      }),
    );
  });

  it("sends bounded row commits to the commit endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            enabled: true,
            configured: true,
            managedByEnvironment: false,
            connectionDisplay: "postgresql://localhost/risuai",
            poolMax: 10,
            revision: 4,
            initialized: true,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ revision: 5 }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const storage = new NodePostgresStorage(async () => "test-auth");
    await storage.getServerConfig();
    const result = await storage.commit({
      baseRevision: 4,
      root: { upserts: [{ key: "temperature", value: 80 }], deletes: [] },
      characters: [],
      chats: [],
      chatManifests: [],
      messages: [],
      messageManifests: [],
    });

    expect(result).toEqual({ revision: 5 });
    expect(storage.getRevision()).toBe(5);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/database-v2/commit");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toMatchObject(
      {
        baseRevision: 4,
        root: { upserts: [{ key: "temperature", value: 80 }] },
        characters: [],
      },
    );
  });

  it("fetches revision history from the server API", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            enabled: true,
            configured: true,
            managedByEnvironment: false,
            connectionDisplay: "postgresql://localhost/risuai",
            poolMax: 10,
            revision: 2,
            initialized: true,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            revisions: [
              {
                id: 2,
                storage_revision: 2,
                database_initialized: true,
                scope: "database",
                action: "sync",
                restored_from_revision: null,
                created_at: "2026-03-30T00:00:00Z",
                change_count: 5,
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const storage = new NodePostgresStorage(async () => "test-auth");
    await storage.getServerConfig();

    const revisions = await storage.listRevisions(10);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].id).toBe(2);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/database-v2/revisions?limit=10",
    );
  });

  it("lists database tables and queries table columns and rows through the server API", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            enabled: true,
            configured: true,
            managedByEnvironment: false,
            connectionDisplay: "postgresql://localhost/risuai",
            poolMax: 10,
            revision: 2,
            initialized: true,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            tables: [
              { name: "character.characters", rowCount: 2 },
              { name: "chat.messages", rowCount: 42 },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              table: "character.characters",
              columns: [
                {
                  name: "id",
                  dataType: "text",
                  nullable: false,
                  primaryKey: true,
                },
              ],
              rows: [{ id: "c1" }],
              offset: 50,
              limit: 50,
              total: 2,
            },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const storage = new NodePostgresStorage(async () => "test-auth");
    await storage.getServerConfig();

    expect(await storage.listDbTables()).toEqual([
      { name: "character.characters", rowCount: 2 },
      { name: "chat.messages", rowCount: 42 },
    ]);
    expect(
      await storage.getDbTableData("character.characters", {
        offset: 50,
        limit: 50,
        sortColumn: "id",
        sortOrder: "desc",
      }),
    ).toMatchObject({
      table: "character.characters",
      total: 2,
      rows: [{ id: "c1" }],
    });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/database-v2/tables");
    expect(fetchMock.mock.calls[2][0]).toBe(
      "/api/database-v2/tables/character.characters/rows?offset=50&limit=50&sort=id&dir=desc",
    );
  });

  it("searches and filters table rows with column selection through the server API", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            enabled: true,
            configured: true,
            managedByEnvironment: false,
            connectionDisplay: "postgresql://localhost/risuai",
            poolMax: 10,
            revision: 2,
            initialized: true,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              table: "chat.messages",
              columns: [
                {
                  name: "id",
                  dataType: "text",
                  nullable: false,
                  primaryKey: true,
                },
                {
                  name: "content",
                  dataType: "text",
                  nullable: true,
                  primaryKey: false,
                },
              ],
              rows: [{ id: "m1", content: "hello world" }],
              offset: 0,
              limit: 25,
              total: 1,
            },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const storage = new NodePostgresStorage(async () => "test-auth");
    await storage.getServerConfig();

    expect(
      await storage.getDbTableData("chat.messages", {
        search: "hello",
        columns: ["id", "content"],
        limit: 25,
      }),
    ).toMatchObject({
      table: "chat.messages",
      total: 1,
      rows: [{ id: "m1", content: "hello world" }],
    });
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/database-v2/tables/chat.messages/rows?offset=0&limit=25&search=hello&columns=id%2Ccontent",
    );
  });

  it("loads database with shallow=true by default and supports full loading", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "ready",
            revision: 10,
            database: { username: "test-user", characters: [], theme: "dark" },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "ready",
            revision: 10,
            database: { username: "test-user", characters: [] },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const storage = new NodePostgresStorage(async () => "test-auth");
    const shallowResult = await storage.loadDatabase();
    const shallowDb = shallowResult?.database as any;
    expect(shallowDb?.username).toBe("test-user");
    expect(shallowDb?.theme).toBe("dark");
    expect(shallowDb.isDomainLoaded("plugins")).toBe(false);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/database-v2?shallow=true");

    const fullResult = await storage.loadDatabase({ shallow: false });
    const fullDb = fullResult?.database as any;
    expect(fullDb?.username).toBe("test-user");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/database-v2?shallow=false");
  });

  it("loads chat details on demand", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "ready",
            revision: 10,
            database: { username: "test-user", characters: [] },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            chat: {
              id: "chat-123",
              name: "My Chat",
              localLore: [{ key: "lore1" }],
              message: [
                { chatId: "msg-1", role: "user", data: "hello" },
                { chatId: "msg-2", role: "char", data: "hi there" },
              ],
            },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const storage = new NodePostgresStorage(async () => "test-auth");
    await storage.loadDatabase();

    const chat = await storage.loadChat("chat-123");
    expect(chat?.id).toBe("chat-123");
    expect(chat?.message).toHaveLength(2);
    expect(chat?.localLore).toHaveLength(1);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/database-v2/chats/chat-123");
  });

  it("loads full chat history from the message-only endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          messages: [
            { chatId: "msg-1", role: "user", data: "oldest" },
            { chatId: "msg-2", role: "char", data: "newest" },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const storage = new NodePostgresStorage(async () => "test-auth");
    (storage as any).status = "enabled";

    const messages = await storage.loadChatMessages("chat-123");

    expect(messages).toHaveLength(2);
    expect(messages[0].chatId).toBe("msg-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/database-v2/chats/chat-123/messages",
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "GET",
      cache: "no-cache",
      headers: { "risu-auth": "test-auth" },
    });
  });

  it("requests generation history without heavy message metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          messages: [{ chatId: "msg-1", role: "user", data: "hello" }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const storage = new NodePostgresStorage(async () => "test-auth");
    (storage as any).status = "enabled";

    await storage.loadChatMessages("chat-123", { mode: "generation" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/database-v2/chats/chat-123/messages?mode=generation",
    );
  });

  it("requests bounded chat pages with absolute offsets", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          messages: [{ chatId: "msg-40", role: "char", data: "older" }],
          offset: 40,
          total: 100,
          hasMore: true,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const storage = new NodePostgresStorage(async () => "test-auth");
    (storage as any).status = "enabled";

    const page = await storage.loadChatMessagePage("chat-123", 60, 20);

    expect(page).toMatchObject({ offset: 40, total: 100, hasMore: true });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/database-v2/chats/chat-123/messages?limit=20&before=60",
    );
  });

  it("loads character details on demand", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "ready",
            revision: 10,
            database: { username: "test-user", characters: [] },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            character: {
              chaId: "char-123",
              name: "Loaded Character",
              globalLore: [{ key: "world-lore" }],
              emotionImages: [["happy", "data:image/png;base64,..."]],
            },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const storage = new NodePostgresStorage(async () => "test-auth");
    await storage.loadDatabase();

    const char = await storage.loadCharacter("char-123");
    expect(char?.chaId).toBe("char-123");
    expect(char?.name).toBe("Loaded Character");
    expect((char as any)?.globalLore).toHaveLength(1);
    expect((char as any)?.emotionImages).toHaveLength(1);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/database-v2/characters/char-123",
    );
  });

  it("loads and caches individual plugin custom storage keys on demand", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            keys: ["cache_key_1", "cache_key_2"],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            key: "cache_key_1",
            value: { count: 42, label: "test" },
            hash: "key-1-hash",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal("fetch", fetchMock);

    const storage = new NodePostgresStorage(async () => "test-auth");
    (storage as any).status = "enabled";

    const keys = await storage.listPluginCustomStorageKeys();
    expect(keys).toEqual(["cache_key_1", "cache_key_2"]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/database-v2/plugin-custom-storage/keys",
    );

    // First load of key: 200 OK -> saves to local cache
    const val1 = await storage.loadPluginCustomStorageKey("cache_key_1");
    expect(val1).toEqual({ count: 42, label: "test" });
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/database-v2/plugin-custom-storage/keys/cache_key_1",
    );

    // Second load of key: sends If-None-Match, returns 304 -> uses cached value
    const val2 = await storage.loadPluginCustomStorageKey("cache_key_1");
    expect(val2).toEqual({ count: 42, label: "test" });
    expect(fetchMock.mock.calls[2][1].headers["If-None-Match"]).toBe(
      '"risu-plugin-key-key-1-hash"',
    );
  });

  it("keeps startup shallow and loads preset summaries and one document separately", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "ready",
            revision: 10,
            database: { username: "test-user", characters: [] },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            presets: [
              {
                id: "123e4567-e89b-42d3-a456-426614174000",
                position: 0,
                name: "Preset Alpha",
                image: "",
                apiType: "openai",
                aiModel: "gpt-test",
                hash: "preset-hash",
              },
            ],
            hash: "list-hash",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            preset: {
              id: "123e4567-e89b-42d3-a456-426614174000",
              name: "Preset Alpha",
              temperature: 75,
            },
            hash: "preset-hash",
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const storage = new NodePostgresStorage(async () => "test-auth");
    const result = (await storage.loadDatabase()) as any;
    const db = result.database;
    expect(db).toBeDefined();
    expect(db.isSql).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.isDomainLoaded("personas")).toBe(false);
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === "/api/database-v2/bootstrap",
      ),
    ).toBe(false);
    const summaries = await storage.listBotPresets();
    expect(summaries[0]).toMatchObject({ name: "Preset Alpha", position: 0 });
    const preset = await storage.loadBotPreset(summaries[0].id);
    expect(preset).toMatchObject({ name: "Preset Alpha", temperature: 75 });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/database-v2/presets");
    expect(fetchMock.mock.calls[2][0]).toBe(
      "/api/database-v2/presets/123e4567-e89b-42d3-a456-426614174000",
    );
  });

  it("loads bot chat stats from /api/database-v2/bot-stats", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/postgres-config") {
        return {
          status: 200,
          json: async () => ({
            enabled: true,
            configured: true,
            managedByEnvironment: false,
            connectionDisplay: "postgres",
            poolMax: 10,
            revision: 1,
            initialized: true,
          }),
        };
      }
      if (url === "/api/database-v2/bot-stats") {
        return {
          status: 200,
          json: async () => ({
            stats: [
              {
                id: "char-1",
                name: "Test Bot",
                isGroup: false,
                totalSessions: 3,
                totalMessages: 42,
                userMessages: 21,
                botMessages: 21,
                longestSessionMessages: 20,
                lastActiveDate: 1724234567890,
                avgBotMessageLen: 350,
                avgUserMessageLen: 45,
                avgMessagesPerSession: 14,
              },
            ],
          }),
        };
      }
      return { status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const storage = new NodePostgresStorage(async () => "test-auth");
    (storage as any).status = "enabled";
    const stats = await storage.getBotChatStats();

    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      id: "char-1",
      name: "Test Bot",
      totalSessions: 3,
      totalMessages: 42,
      avgBotMessageLen: 350,
      avgUserMessageLen: 45,
      avgMessagesPerSession: 14,
    });
  });
});


describe("NodePostgresStorage concurrent commit handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("tags requests with a client id and retries a revision conflict", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            enabled: true,
            configured: true,
            managedByEnvironment: false,
            connectionDisplay: "postgresql://localhost/risuai",
            poolMax: 10,
            revision: 4,
            initialized: true,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ revision: 5 }), { status: 409 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ revision: 6 }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const storage = new NodePostgresStorage(async () => "test-auth");
    await storage.getServerConfig();

    const result = await storage.commit({
      baseRevision: 4,
      action: "message",
      root: { upserts: [], deletes: [] },
      characters: [],
      chats: [],
      chatManifests: [],
      messages: [],
      messageManifests: [],
    });

    expect(result).toEqual({ revision: 6 });
    expect(storage.getRevision()).toBe(6);
    const firstCommit = fetchMock.mock.calls[1][1];
    const retryCommit = fetchMock.mock.calls[2][1];
    expect(JSON.parse(firstCommit.body as string).baseRevision).toBe(4);
    expect(JSON.parse(retryCommit.body as string).baseRevision).toBe(5);

    const firstHeaders = firstCommit.headers as Record<string, string>;
    const retryHeaders = retryCommit.headers as Record<string, string>;
    expect(firstHeaders["risu-auth"]).toBe("test-auth");
    expect(firstHeaders["x-risu-client-id"]).toBeTruthy();
    expect(retryHeaders["x-risu-client-id"]).toBe(
      firstHeaders["x-risu-client-id"],
    );
  });
});
