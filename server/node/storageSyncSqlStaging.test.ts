import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const {
  StorageSyncSqlError,
  StorageSyncSqlStagingStore,
} = require("./storageSyncSqlStaging.cjs");

const tempRoots: string[] = [];
function sha256(data: Uint8Array | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function tempStore() {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "risu-sql-sync-"),
  );
  tempRoots.push(root);
  return new StorageSyncSqlStagingStore(root);
}

function targetSession(id = "session-1") {
  return { id, role: "target", status: "assets-ready" } as any;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.promises.rm(root, { recursive: true, force: true })),
  );
});

describe("StorageSyncSqlStagingStore", () => {
  it("stages a SQL stream in resumable chunks", async () => {
    const store = await tempStore();
    const session = targetSession();
    const body = Buffer.from('{"type":"root"}\n{"type":"message"}\n');
    const plan = await store.plan(session, {
      formatVersion: 1,
      size: body.length,
      recordCount: 2,
      sha256: sha256(body),
    });
    expect(plan).toMatchObject({
      offset: 0,
      state: "pending",
      status: "receiving-sql",
    });

    const first = body.subarray(0, 11);
    await store.writeChunk(session, 0, first);
    expect(store.getPlan(session)).toMatchObject({
      offset: first.length,
      state: "receiving",
    });
    await store.writeChunk(session, first.length, body.subarray(first.length));
    expect(store.getPlan(session)).toMatchObject({
      offset: body.length,
      state: "ready",
      status: "sql-ready",
    });
    expect(await fs.promises.readFile(store.filePath(session.id))).toEqual(
      body,
    );
  });

  it("rejects offset drift without changing progress", async () => {
    const store = await tempStore();
    const session = targetSession("offset-session");
    const body = Buffer.from("abc\n");
    await store.plan(session, {
      formatVersion: 1,
      size: body.length,
      recordCount: 1,
      sha256: sha256(body),
    });
    await expect(store.writeChunk(session, 1, body)).rejects.toMatchObject({
      code: "offset_mismatch",
    });
    expect(store.getPlan(session).offset).toBe(0);
  });

  it("resets the stream after a checksum mismatch", async () => {
    const store = await tempStore();
    const session = targetSession("bad-checksum");
    const body = Buffer.from("wrong\n");
    await store.plan(session, {
      formatVersion: 1,
      size: body.length,
      recordCount: 1,
      sha256: sha256("right\n"),
    });
    await expect(store.writeChunk(session, 0, body)).rejects.toMatchObject({
      code: "sql_checksum_mismatch",
    });
    expect(store.getPlan(session)).toMatchObject({
      offset: 0,
      state: "pending",
    });
    await expect(
      fs.promises.stat(store.filePath(session.id)),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("accepts a correctly declared empty stream", async () => {
    const store = await tempStore();
    const session = targetSession("empty-stream");
    const plan = await store.plan(session, {
      formatVersion: 1,
      size: 0,
      recordCount: 0,
      sha256: sha256(Buffer.alloc(0)),
    });
    expect(plan).toMatchObject({
      offset: 0,
      state: "ready",
      status: "sql-ready",
    });
  });

  it("does not allow SQL staging before assets finish", async () => {
    const store = await tempStore();
    const session = {
      ...targetSession("assets-first"),
      status: "receiving-assets",
      assets: {},
    };
    await expect(
      store.plan(session, {
        formatVersion: 1,
        size: 4,
        recordCount: 1,
        sha256: sha256("abc\n"),
      }),
    ).rejects.toMatchObject({ code: "assets_not_ready" });
    expect(session.sql).toBeUndefined();
  });
});
