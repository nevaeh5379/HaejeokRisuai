import { describe, expect, it, vi } from "vitest";
import {
  DatabaseSnapshotTransfer,
  DATABASE_BATCH_OPERATIONS,
  prepareDatabaseSnapshot,
} from "./databaseSnapshot.svelte";
import {
  createDatabaseSnapshotReceiver,
  type SnapshotOperation,
} from "./databaseTransfer";
import { SandboxHost } from "./factory";
import {
  reactiveDatabase,
  legacyDatabaseSnapshot,
} from "src/test/pluginDatabaseFixture.svelte";

async function receive(
  source: DatabaseSnapshotTransfer,
): Promise<Record<string, any>> {
  const receiver = createDatabaseSnapshotReceiver();
  try {
    await source.send((operations) => {
      const cloned = structuredClone(operations);
      for (const operation of cloned)
        if (operation[0] === "rootNative") operation[0] = "native";
      receiver.apply(cloned);
    });
    return receiver.finish();
  } catch (error) {
    receiver.abort();
    throw error;
  }
}

describe("plugin database graph transfer", () => {
  it("preserves the legacy read order across lazy loading without resolving a partial database", async () => {
    let finishLoading!: (value: unknown) => void;
    const pluginLoad = new Promise((resolve) => {
      finishLoading = resolve;
    });
    const readCharacters = vi.fn(() => [
      { chats: [{ message: [{ data: "history" }] }] },
    ]);
    const pending = prepareDatabaseSnapshot(
      {
        get characters() {
          return readCharacters();
        },
      },
      ["characters", "plugins"],
      () => pluginLoad,
    );
    expect(readCharacters).not.toHaveBeenCalled();
    const transfer = await pending;
    expect(readCharacters).not.toHaveBeenCalled();
    const received = receive(transfer);
    expect(readCharacters).toHaveBeenCalledTimes(1);
    let complete = false;
    void received.then(() => {
      complete = true;
    });
    await Promise.resolve();
    expect(complete).toBe(false);
    finishLoading([{ name: "plugin" }]);
    expect(await received).toEqual({
      characters: [{ chats: [{ message: [{ data: "history" }] }] }],
      plugins: [{ name: "plugin" }],
    });
    expect(readCharacters).toHaveBeenCalledTimes(1);
    await expect(receive(transfer)).rejects.toThrow("already transferred");
  });

  it("matches legacy default, all, and characters-only payloads with live Svelte proxies", async () => {
    const messages = [{ data: "history", optional: undefined }];
    const chat: Record<string, unknown> = {
      message: messages,
      alias: messages,
      btwSessions: [{ messages }],
      branchState: { messages },
      bytes: new Uint8Array([1, 2]),
      date: new Date(0),
      big: 12n,
      number: NaN,
    };
    const database = reactiveDatabase({
      characters: [{ chats: [chat] }],
      theme: "light",
    });
    database.characters[0].chats[0].note = "proxy update";
    database.characters[0].chats[0].self = database.characters[0].chats[0];
    database.characters[0].chats[0].alias =
      database.characters[0].chats[0].message;
    database.characters[0].chats.push({ message: [{ data: "new chat" }] });
    for (const selection of [undefined, "all", ["characters"]] as (
      string[] | "all" | undefined
    )[]) {
      const keys =
        selection === undefined || selection === "all"
          ? ["characters", "theme"]
          : selection;
      const expected = legacyDatabaseSnapshot(database, keys);
      const result = await receive(
        await prepareDatabaseSnapshot(
          database,
          ["characters", "theme"],
          async () => [],
          selection,
        ),
      );
      expect(result).toEqual(expected);
      const receivedChat = result.characters[0].chats[0];
      expect(receivedChat.message).toBe(receivedChat.alias);
      expect(receivedChat.self).toBe(receivedChat);
      receivedChat.message[0].data = "edited";
      expect(database.characters[0].chats[0].message).toEqual(messages);
    }
  });

  it("preserves legacy capture timing for plain and shallow-native data across plugin I/O", async () => {
    let finishLoading!: (value: unknown) => void;
    const loading = new Promise((resolve) => {
      finishLoading = resolve;
    });
    const message = { data: "before" };
    const stamp = new Date(0);
    let theme = "before";
    const database = {
      characters: [
        {
          message: [message],
          stamp,
          native: new Map<string, unknown>([
            ["message", message],
            ["stamp", stamp],
          ]),
        },
      ],
      get theme() {
        return theme;
      },
    };
    const pending = receive(
      prepareDatabaseSnapshot(
        database,
        ["characters", "plugins", "theme"],
        () => loading,
      ),
    );
    message.data = "after";
    stamp.setTime(1);
    theme = "after";
    finishLoading([]);
    const result = await pending;
    expect(result.characters[0].message[0].data).toBe("before");
    expect(result.characters[0].stamp.getTime()).toBe(0);
    expect(result.characters[0].native.get("message").data).toBe("after");
    expect(result.characters[0].native.get("stamp").getTime()).toBe(1);
    expect(result.theme).toBe("after");
  });

  it("preserves sparse arrays, native types, per-key alias isolation and toJSON cycles", async () => {
    const shared = { value: "shared" };
    const sparse = new Array(5);
    sparse[2] = shared;
    class JsonValue {
      toJSON() {
        return { self: this, shared };
      }
    }
    const json = new JsonValue();
    const source = {
      characters: [
        sparse,
        shared,
        new Map([["value", shared]]),
        new Set([shared]),
        /regexp/gi,
        new ArrayBuffer(8),
        new DataView(new ArrayBuffer(12), 4),
        json,
        json,
      ],
      personas: shared,
    };
    const result = await receive(
      await prepareDatabaseSnapshot(
        source,
        ["characters", "personas"],
        async () => [],
      ),
    );
    expect(result).toEqual(
      legacyDatabaseSnapshot(source, ["characters", "personas"]),
    );
    expect(0 in result.characters[0]).toBe(false);
    expect(result.characters[0][2]).toBe(result.characters[1]);
    expect(result.personas).not.toBe(result.characters[1]);
    expect(result.characters[7]).toBe(result.characters[8]);
    expect(result.characters[7].self).toBe(result.characters[7]);
    expect(result.characters[2].get("value")).not.toBe(result.characters[1]);
  });

  it("retains key read order and snapshot behavior for __proto__ properties", async () => {
    const character: Record<string, unknown> = { name: "Before" };
    Object.defineProperty(character, "__proto__", {
      value: { polluted: true },
      enumerable: true,
    });
    const database = {
      characters: [character],
      get theme() {
        character.name = "After";
        return "light";
      },
    };
    const result = await receive(
      await prepareDatabaseSnapshot(
        database,
        ["characters", "theme"],
        async () => [],
      ),
    );
    expect(result.characters[0].name).toBe("Before");
    expect(Object.getPrototypeOf(result.characters[0])).toBe(Object.prototype);
    expect(result.characters[0]).not.toHaveProperty("polluted");
  });

  it("preserves native Map/Set child aliases across batches and allowed keys", async () => {
    const shared = { data: "native shared value" };
    const database = {
      characters: [
        { map: new Map([["shared", shared]]) },
        ...Array.from({ length: 1000 }, (_, i) => ({ data: "message " + i })),
        { set: new Set([shared]) },
        shared,
      ],
      personas: new Map([["shared", shared]]),
    };
    const result = await receive(
      await prepareDatabaseSnapshot(
        database,
        ["characters", "personas"],
        async () => [],
      ),
    );
    expect(result).toEqual(
      legacyDatabaseSnapshot(database, ["characters", "personas"]),
    );
    const mapChild = result.characters[0].map.get("shared");
    expect(mapChild).toBe(result.characters[1001].set.values().next().value);
    expect(mapChild).toBe(result.personas.get("shared"));
    expect(mapChild).not.toBe(result.characters[1002]);
  });

  it("preserves root and nested property ordering with deferred native leaves", async () => {
    const source = {
      characters: [
        {
          date: new Date(0),
          name: "character",
          bytes: new Uint8Array([1]),
          optional: undefined,
        },
      ],
      personas: new Date(1),
      theme: "light",
    };
    const keys = ["personas", "characters", "theme"];
    const expected = legacyDatabaseSnapshot(source, keys);
    const result = await receive(
      await prepareDatabaseSnapshot(source, keys, async () => []),
    );
    expect(Object.keys(result)).toEqual(Object.keys(expected));
    expect(Object.keys(result.characters[0])).toEqual(
      Object.keys((expected.characters as typeof source.characters)[0]),
    );
    expect(result).toEqual(expected);
  });

  it("skips unrequested keys and reports failed lazy loading", async () => {
    const database = {
      theme: "light",
      get characters() {
        throw new Error("History accessed");
      },
    };
    const loadPlugins = vi.fn(async () => []);
    expect(
      await receive(
        await prepareDatabaseSnapshot(
          database,
          ["characters", "theme", "plugins"],
          loadPlugins,
          ["theme"],
        ),
      ),
    ).toEqual({ theme: "light" });
    expect(loadPlugins).not.toHaveBeenCalled();
    expect(
      await receive(
        await prepareDatabaseSnapshot(
          database,
          ["characters", "theme", "plugins"],
          loadPlugins,
          [],
        ),
      ),
    ).toEqual({});
    await expect(
      receive(
        prepareDatabaseSnapshot(
          { characters: [] },
          ["characters", "plugins"],
          async () => {
            throw new Error("Loading failed");
          },
        ),
      ),
    ).rejects.toThrow("Loading failed");
  });

  it("stages bounded operations without putting character/chat/message copies in any batch", async () => {
    const database = reactiveDatabase({
      characters: [
        {
          chats: [
            {
              message: Array.from({ length: 10000 }, (_, i) => ({
                data: `message ${i}`,
                role: "char",
              })),
            },
          ],
        },
      ],
    });
    const source = await prepareDatabaseSnapshot(
      database,
      ["characters"],
      async () => [],
    );
    const receiver = createDatabaseSnapshotReceiver();
    let batches = 0;
    await source.send((operations) => {
      expect(operations.length).toBeLessThanOrEqual(DATABASE_BATCH_OPERATIONS);
      expect(
        operations.some(
          (operation) =>
            operation[0] === "native" || operation[0] === "rootNative",
        ),
      ).toBe(false);
      receiver.apply(structuredClone(operations));
      batches++;
    });
    expect(batches).toBeGreaterThan(100);
    expect(receiver.finish()).toEqual(
      legacyDatabaseSnapshot(database, ["characters"]),
    );
  });

  it("disposes the source on failure and releases aborted receiver graphs", async () => {
    const read = vi.fn(() => {
      throw new Error("Read failed");
    });
    const source = new DatabaseSnapshotTransfer(read);
    await expect(receive(source)).rejects.toThrow("Read failed");
    await expect(receive(source)).rejects.toThrow("already transferred");
    expect(read).toHaveBeenCalledTimes(1);
    const receiver = createDatabaseSnapshotReceiver();
    receiver.apply([
      ["object", 0],
      ["set", 0, "value", [0, "partial"]],
      ["root", "characters", [1, 0]],
    ]);
    receiver.abort();
    expect(receiver.finish()).toEqual({});
  });

  it("embeds the receiver without dependencies outside its sandbox script", () => {
    const embedded = new Function(
      `return (${createDatabaseSnapshotReceiver.toString()})();`,
    )();
    embedded.apply([
      ["array", 0, 1],
      ["set", 0, 0, [0, "history"]],
      ["root", "characters", [1, 0]],
    ]);
    expect(embedded.finish()).toEqual({ characters: ["history"] });
  });

  it("rejects an incomplete native-leaf transfer and frees deferred assignments", () => {
    const receiver = createDatabaseSnapshotReceiver();
    receiver.apply([
      ["object", 0],
      ["set", 0, "missing", [1, 1]],
      ["root", "characters", [1, 0]],
    ]);
    expect(() => receiver.finish()).toThrow(
      "Incomplete database snapshot transfer",
    );
    receiver.abort();
    expect(receiver.finish()).toEqual({});
  });
});

describe("sandbox database graph transport", () => {
  it("reports failed partial transfers without resolving a truncated database", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const host = new SandboxHost({
      getDatabase: () =>
        prepareDatabaseSnapshot(
          { characters: [] },
          ["characters"],
          async () => [],
        ),
    });
    const received: any[] = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    host.run(iframe, "");
    vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(
      (message: any) => {
        if (message.type === "DATABASE_PART")
          throw new Error("Transfer failed");
        received.push(structuredClone(message));
      },
    );
    try {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          data: { type: "CALL_ROOT", method: "getDatabase", reqId: "failed" },
        }),
      );
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]).toEqual({
        type: "RESPONSE",
        reqId: "failed",
        error: "Failed to post message to iframe: Transfer failed",
      });
      expect(received[0]).not.toHaveProperty("databaseSnapshot");
    } finally {
      host.terminate();
      iframe.remove();
      vi.restoreAllMocks();
    }
  });

  it("keeps concurrent requests separate and never posts a full database payload", async () => {
    const order: string[] = [];
    const database = {
      get characters() {
        order.push("read");
        return [{ chats: [{ message: [{ data: "history" }] }] }];
      },
    };
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const host = new SandboxHost({
      getDatabase: () =>
        prepareDatabaseSnapshot(database, ["characters"], async () => []),
    });
    const receivers = new Map<
      string,
      ReturnType<typeof createDatabaseSnapshotReceiver>
    >();
    const received: any[] = [];
    const envelopes: any[] = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    host.run(iframe, "");
    vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(
      (message: any) => {
        envelopes.push(message);
        const cloned = structuredClone(message);
        if (cloned.type === "DATABASE_PART") {
          order.push("part");
          if (!receivers.has(cloned.reqId))
            receivers.set(cloned.reqId, createDatabaseSnapshotReceiver());
          receivers
            .get(cloned.reqId)!
            .apply(cloned.databaseOps as SnapshotOperation[]);
        } else {
          order.push("complete");
          expect(cloned.databaseSnapshot).toBe(true);
          expect(cloned).not.toHaveProperty("result");
          received.push(receivers.get(cloned.reqId)!.finish());
        }
      },
    );
    try {
      for (const reqId of ["first", "second"])
        window.dispatchEvent(
          new MessageEvent("message", {
            source: iframe.contentWindow,
            data: { type: "CALL_ROOT", method: "getDatabase", reqId },
          }),
        );
      await vi.waitFor(() => expect(received).toHaveLength(2));
      expect(order).toEqual([
        "read",
        "part",
        "read",
        "part",
        "complete",
        "complete",
      ]);
      expect(received[0]).toEqual({
        characters: [{ chats: [{ message: [{ data: "history" }] }] }],
      });
      expect(received[1]).toEqual(received[0]);
      for (const envelope of envelopes)
        if (envelope.databaseOps) expect(envelope.databaseOps).toHaveLength(0);
      expect(log).not.toHaveBeenCalled();
    } finally {
      host.terminate();
      iframe.remove();
      vi.restoreAllMocks();
    }
  });
});
