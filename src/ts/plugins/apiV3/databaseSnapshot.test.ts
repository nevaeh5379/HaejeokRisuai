import { describe, expect, it, vi } from "vitest";
import {
  DeferredDatabaseSnapshot,
  prepareDatabaseSnapshot,
} from "./databaseSnapshot.svelte";
import { SandboxHost } from "./factory";

describe("deferred plugin database snapshots", () => {
  it("waits for plugin loading without reading or copying character history", async () => {
    let finishLoading!: (value: unknown) => void;
    const pluginLoad = new Promise((resolve) => {
      finishLoading = resolve;
    });
    const readCharacters = vi.fn(() => [
      { chats: [{ message: [{ data: "history" }] }] },
    ]);
    const database = {
      get characters() {
        return readCharacters();
      },
    };
    const pending = prepareDatabaseSnapshot(
      database,
      ["characters", "plugins"],
      () => pluginLoad,
    );
    expect(readCharacters).not.toHaveBeenCalled();
    finishLoading([{ name: "plugin" }]);
    const deferred = await pending;
    expect(readCharacters).not.toHaveBeenCalled();
    expect(deferred.materialize()).toEqual({
      characters: [{ chats: [{ message: [{ data: "history" }] }] }],
      plugins: [{ name: "plugin" }],
    });
    expect(readCharacters).toHaveBeenCalledTimes(1);
    expect(() => deferred.materialize()).toThrow("already materialized");
  });

  it("retains all history, types, cycles, and detached mutation behavior for existing calls", async () => {
    const messages = [{ data: "history", value: undefined }];
    const chat: Record<string, unknown> = {
      message: messages,
      alias: messages,
      btwSessions: [{ messages }],
      branchState: { messages },
      bytes: new Uint8Array([1, 2]),
      date: new Date(0),
    };
    chat.self = chat;
    const database = { characters: [{ chats: [chat] }], theme: "light" };
    for (const includeOnly of [undefined, "all", ["characters"]] as (
      string[] | "all" | undefined
    )[]) {
      const deferred = await prepareDatabaseSnapshot(
        database,
        ["characters", "theme"],
        async () => [],
        includeOnly,
      );
      const result = deferred.materialize();
      expect(result.characters).toEqual(structuredClone(database.characters));
      const snapshotChat = (result.characters as typeof database.characters)[0]
        .chats[0];
      expect(snapshotChat.message).toBe(snapshotChat.alias);
      expect(snapshotChat.self).toBe(snapshotChat);
      (snapshotChat.message as typeof messages)[0].data = "edited";
      expect(messages[0].data).toBe("history");
    }
  });

  it("does not load or snapshot omitted keys, including on lazy-load failure", async () => {
    const database = {
      theme: "light",
      get characters() {
        throw new Error("History accessed");
      },
    };
    const loadPlugins = vi.fn(async () => []);
    expect(
      (
        await prepareDatabaseSnapshot(
          database,
          ["characters", "theme", "plugins"],
          loadPlugins,
          ["theme"],
        )
      ).materialize(),
    ).toEqual({ theme: "light" });
    expect(loadPlugins).not.toHaveBeenCalled();
    await expect(
      prepareDatabaseSnapshot(database, ["characters", "plugins"], async () => {
        throw new Error("Loading failed");
      }),
    ).rejects.toThrow("Loading failed");
  });

  it("releases the deferred source even when materialization throws", () => {
    const read = vi.fn(() => {
      throw new Error("Snapshot failed");
    });
    const deferred = new DeferredDatabaseSnapshot(read);
    expect(() => deferred.materialize()).toThrow("Snapshot failed");
    expect(() => deferred.materialize()).toThrow("already materialized");
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("sandbox database snapshot transfer", () => {
  it("clears failed transfer payloads and preserves the error response", async () => {
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
    const envelopes: any[] = [];
    const received: any[] = [];
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    host.run(iframe, "");
    vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(
      (message: any) => {
        if ("result" in message) {
          envelopes.push(message);
          throw new Error("Transfer failed");
        }
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
      expect(envelopes[0]).not.toHaveProperty("result");
      expect(errorLog).toHaveBeenCalledTimes(1);
    } finally {
      host.terminate();
      iframe.remove();
      vi.restoreAllMocks();
    }
  });

  it("materializes and posts each concurrent result without retaining a host payload or logging it", async () => {
    const order: string[] = [];
    const database = {
      get characters() {
        order.push("snapshot");
        return [{ chats: [{ message: [{ data: "history" }] }] }];
      },
    };
    const api = {
      getDatabase: () =>
        prepareDatabaseSnapshot(database, ["characters"], async () => []),
    };
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const host = new SandboxHost(api);
    const received: any[] = [];
    const envelopes: any[] = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    host.run(iframe, "");
    vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(
      (message: any) => {
        order.push("post");
        envelopes.push(message);
        received.push(structuredClone(message));
      },
    );
    try {
      for (const reqId of ["first", "second"]) {
        window.dispatchEvent(
          new MessageEvent("message", {
            source: iframe.contentWindow,
            data: { type: "CALL_ROOT", method: "getDatabase", reqId },
          }),
        );
      }
      await vi.waitFor(() => expect(received).toHaveLength(2));
      expect(order).toEqual(["snapshot", "post", "snapshot", "post"]);
      for (const response of received) {
        expect(response.result).toEqual({
          characters: [{ chats: [{ message: [{ data: "history" }] }] }],
        });
      }
      for (const response of envelopes)
        expect(response).not.toHaveProperty("result");
      expect(log).not.toHaveBeenCalled();
    } finally {
      host.terminate();
      iframe.remove();
      vi.restoreAllMocks();
    }
  });
});
