import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { StorageSyncRecoveryStore } = require("./storageSyncRecovery.cjs") as {
  StorageSyncRecoveryStore: new (root: string) => any;
};

const roots: string[] = [];
async function makeStore() {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "risu-recovery-"),
  );
  roots.push(root);
  return new StorageSyncRecoveryStore(root);
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.promises.rm(root, { recursive: true, force: true })),
  );
});
function session(id = "session-1") {
  return {
    id,
    serverRevision: 7,
    summary: { initialized: true },
  };
}

function asset(id: string, key: string, state: "ready" | "skipped" = "ready") {
  return {
    id,
    key,
    size: 3,
    sha256: "a".repeat(64),
    offset: 3,
    state,
  };
}

function hexToKey(hex: string) {
  return Buffer.from(hex, "hex").toString("utf8");
}

describe("StorageSyncRecoveryStore", () => {
  it("backs up only assets that will be overwritten", async () => {
    const store = await makeStore();
    const reads: string[] = [];
    const activeStorage = {
      openReadStream: vi.fn(async (hex: string) => {
        const key = hexToKey(hex);
        reads.push(key);
        if (key === "assets/existing.bin") {
          return {
            exists: true,
            contentLength: 3,
            stream: Readable.from([Buffer.from([9, 8, 7])]),
          };
        }
        return { exists: false };
      }),
    };
    const plan = {
      assets: [
        asset("1".repeat(64), "assets/existing.bin"),
        asset("2".repeat(64), "assets/new.bin"),
        asset("3".repeat(64), "assets/skipped.bin", "skipped"),
      ],
    };

    const snapshot = await store.prepare(session(), plan, activeStorage);
    expect(snapshot.state).toBe("prepared");
    expect(reads.sort()).toEqual(["assets/existing.bin", "assets/new.bin"]);
    expect(snapshot.assets).toEqual([
      expect.objectContaining({
        id: "1".repeat(64),
        key: "assets/existing.bin",
        existed: true,
        size: 3,
      }),
      {
        id: "2".repeat(64),
        key: "assets/new.bin",
        existed: false,
      },
    ]);
    expect(
      await fs.promises.readFile(store.assetPath("session-1", "1".repeat(64))),
    ).toEqual(Buffer.from([9, 8, 7]));
  });

  it("reuses a completed prepared snapshot for the same plan", async () => {
    const store = await makeStore();
    const activeStorage = {
      openReadStream: vi.fn(async () => ({ exists: false })),
    };
    const plan = { assets: [asset("4".repeat(64), "assets/new.bin")] };
    await store.prepare(session(), plan, activeStorage);
    await store.prepare(session(), plan, activeStorage);
    expect(activeStorage.openReadStream).toHaveBeenCalledTimes(1);
  });

  it("promotes atomically and removes the previous recovery snapshot", async () => {
    const store = await makeStore();
    const activeStorage = {
      openReadStream: vi.fn(async () => ({ exists: false })),
    };
    const firstPlan = { assets: [asset("5".repeat(64), "assets/first.bin")] };
    const secondPlan = { assets: [asset("6".repeat(64), "assets/second.bin")] };
    await store.prepare(session("first"), firstPlan, activeStorage);
    store.attachDatabaseRecoveryPoint("first", {
      storageRevision: 7,
      revisionId: 11,
      initialized: true,
    });
    await store.promote("first");
    expect(store.getCurrent()).toMatchObject({ id: "first", state: "current" });

    await store.prepare(session("second"), secondPlan, activeStorage);
    await store.promote("second");
    expect(store.getCurrent()).toMatchObject({ id: "second" });
    await expect(
      fs.promises.stat(store.snapshotDirectory("first")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores overwritten assets and removes keys that did not exist", async () => {
    const store = await makeStore();
    const activeStorage = {
      openReadStream: vi.fn(async (hex: string) => {
        const key = hexToKey(hex);
        if (key === "assets/old.bin") {
          return {
            exists: true,
            contentLength: 3,
            stream: Readable.from([Buffer.from("old")]),
          };
        }
        return { exists: false };
      }),
    };
    const plan = {
      assets: [
        asset("7".repeat(64), "assets/old.bin"),
        asset("8".repeat(64), "assets/new.bin"),
      ],
    };
    const snapshot = await store.prepare(session(), plan, activeStorage);
    const restored = new Map<string, Buffer>();
    const removed: string[] = [];
    const restoreStorage = {
      createWriteStream(hex: string) {
        const chunks: Buffer[] = [];
        const writable = new Writable({
          write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
          },
        });
        return {
          stream: writable,
          done: async () => {
            restored.set(hexToKey(hex), Buffer.concat(chunks));
          },
          abort: async () => {},
        };
      },
      remove: vi.fn(async (hex: string) => {
        removed.push(hexToKey(hex));
      }),
    };

    await expect(
      store.restoreAssets(snapshot, restoreStorage),
    ).resolves.toEqual({
      restored: 2,
    });
    expect(restored.get("assets/old.bin")).toEqual(Buffer.from("old"));
    expect(removed).toEqual(["assets/new.bin"]);
  });

  it("limits recovery asset reads to two concurrent streams", async () => {
    const store = await makeStore();
    let active = 0;
    let maxActive = 0;
    const activeStorage = {
      openReadStream: vi.fn(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return {
          exists: true,
          contentLength: 1,
          stream: Readable.from([Buffer.from([1])]),
        };
      }),
    };
    const assets = Array.from({ length: 6 }, (_, index) =>
      asset(
        String(index + 1)
          .repeat(64)
          .slice(0, 64),
        `assets/${index}.bin`,
      ),
    );
    await store.prepare(session(), { assets }, activeStorage);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
