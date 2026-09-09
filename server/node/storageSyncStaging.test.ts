import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const {
  StorageSyncAssetError,
  StorageSyncStagingStore,
  normalizeManifest,
} = require("./storageSyncStaging.cjs");

function sha256(data: Uint8Array | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function targetSession(id = "session-1") {
  return { id, role: "target", status: "created" } as any;
}

const tempRoots: string[] = [];
async function tempStore() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "risu-sync-"));
  tempRoots.push(root);
  return new StorageSyncStagingStore(root);
}
afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.promises.rm(root, { recursive: true, force: true })),
  );
});

describe("storage sync asset staging", () => {
  it("rejects malformed, duplicate, and unsafe aggregate manifests", () => {
    expect(() =>
      normalizeManifest([{ key: "a", size: -1, sha256: "x" }]),
    ).toThrow(StorageSyncAssetError);
    const digest = sha256("a");
    expect(() =>
      normalizeManifest([
        { key: "assets/a", size: 1, sha256: digest },
        { key: "assets/a", size: 1, sha256: digest },
      ]),
    ).toThrow(/Duplicate/);
    expect(() =>
      normalizeManifest([
        { key: "assets/a", size: Number.MAX_SAFE_INTEGER, sha256: digest },
        { key: "assets/b", size: 1, sha256: digest },
      ]),
    ).toThrow(/total size/);
  });
  it("deduplicates assets by size and checksum", async () => {
    const store = await tempStore();
    const session = targetSession();
    const existing = Buffer.from("already-here");
    const incoming = Buffer.from("send-me");
    const existingHex = Buffer.from("assets/existing.png").toString("hex");
    const activeStorage = {
      async openReadStream(hex: string) {
        if (hex !== existingHex) return { exists: false };
        return {
          exists: true,
          buffer: existing,
          contentLength: existing.length,
        };
      },
    };
    const plan = await store.planAssets(
      session,
      [
        {
          key: "assets/existing.png",
          size: existing.length,
          sha256: sha256(existing),
        },
        {
          key: "assets/new.png",
          size: incoming.length,
          sha256: sha256(incoming),
        },
      ],
      activeStorage,
    );
    expect(plan.skippedCount).toBe(1);
    expect(plan.missingCount).toBe(1);
    expect(plan.remainingBytes).toBe(incoming.length);
    expect(
      plan.assets.find((asset: any) => asset.key.endsWith("existing.png")),
    ).toMatchObject({ state: "skipped" });
  });
  it("resumes exact offsets and marks a verified asset ready", async () => {
    const store = await tempStore();
    const session = targetSession();
    const data = Buffer.from("abcdefghij");
    const plan = await store.planAssets(
      session,
      [{ key: "assets/resume.bin", size: data.length, sha256: sha256(data) }],
      { openReadStream: async () => ({ exists: false }) },
    );
    const asset = plan.assets[0];
    await store.writeAssetChunk(session, asset.id, 0, data.subarray(0, 4));
    expect(store.getPlan(session).assets[0]).toMatchObject({
      offset: 4,
      state: "receiving",
    });
    await expect(
      store.writeAssetChunk(session, asset.id, 3, data.subarray(4, 7)),
    ).rejects.toMatchObject({ code: "offset_mismatch" });
    await store.writeAssetChunk(session, asset.id, 4, data.subarray(4));
    expect(store.getPlan(session)).toMatchObject({
      status: "assets-ready",
      remainingBytes: 0,
    });
    const staged = await fs.promises.readFile(
      store.assetPath(session.id, asset.id),
    );
    expect(staged.equals(data)).toBe(true);
  });

  it("deletes a completed staging file when checksum verification fails", async () => {
    const store = await tempStore();
    const session = targetSession();
    const expected = Buffer.from("good");
    const plan = await store.planAssets(
      session,
      [
        {
          key: "assets/bad.bin",
          size: expected.length,
          sha256: sha256(expected),
        },
      ],
      { openReadStream: async () => ({ exists: false }) },
    );
    const asset = plan.assets[0];
    await expect(
      store.writeAssetChunk(session, asset.id, 0, Buffer.from("evil")),
    ).rejects.toMatchObject({ code: "asset_checksum_mismatch" });
    expect(store.getPlan(session).assets[0]).toMatchObject({
      offset: 0,
      state: "pending",
    });
    await expect(
      fs.promises.stat(store.assetPath(session.id, asset.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects overlapping uploads and excessive request concurrency", async () => {
    const store = await tempStore();
    const session = targetSession();
    const data = Buffer.from("chunk");
    const plan = await store.planAssets(
      session,
      [{ key: "assets/chunk.bin", size: data.length, sha256: sha256(data) }],
      { openReadStream: async () => ({ exists: false }) },
    );
    const asset = session.assets[plan.assets[0].id];
    asset.uploading = true;
    await expect(
      store.writeAssetChunk(session, asset.id, 0, data),
    ).rejects.toMatchObject({ code: "asset_upload_in_progress" });
    asset.uploading = false;
    session.activeUploads = 2;
    await expect(
      store.writeAssetChunk(session, asset.id, 0, data),
    ).rejects.toMatchObject({ code: "too_many_uploads" });
  });

  it("cleans all staged data on cancellation", async () => {
    const store = await tempStore();
    const session = targetSession("cancel-me");
    const data = Buffer.from("partial-data");
    const plan = await store.planAssets(
      session,
      [{ key: "assets/cancel.bin", size: data.length, sha256: sha256(data) }],
      { openReadStream: async () => ({ exists: false }) },
    );
    await store.writeAssetChunk(
      session,
      plan.assets[0].id,
      0,
      data.subarray(0, 3),
    );
    expect(
      await fs.promises.stat(store.sessionDirectory(session.id)),
    ).toBeTruthy();
    await store.cleanup(session.id);
    await expect(
      fs.promises.stat(store.sessionDirectory(session.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rolls back a failed asset plan so it can be retried", async () => {
    const store = await tempStore();
    const session = targetSession("retry-plan");
    await expect(
      store.planAssets(
        session,
        [{ key: "assets/empty.bin", size: 0, sha256: "0".repeat(64) }],
        { openReadStream: async () => ({ exists: false }) },
      ),
    ).rejects.toMatchObject({ code: "asset_checksum_mismatch" });
    expect(session).toMatchObject({ status: "created" });
    expect(session.assets).toBeUndefined();
    await expect(
      fs.promises.stat(store.planPath(session.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.promises.stat(store.sessionDirectory(session.id))).toBeTruthy();

    const plan = await store.planAssets(
      session,
      [{ key: "assets/empty.bin", size: 0, sha256: sha256("") }],
      { openReadStream: async () => ({ exists: false }) },
    );
    expect(plan).toMatchObject({ status: "assets-ready", remainingBytes: 0 });
  });
  it("hydrates asset offsets from staged files after restart", async () => {
    const store = await tempStore();
    const session = targetSession("restart-assets");
    const body = Buffer.from("abcdefghij");
    const plan = await store.planAssets(
      session,
      [{ key: "assets/restart.bin", size: body.length, sha256: sha256(body) }],
      { openReadStream: async () => ({ exists: false }) },
    );
    await store.writeAssetChunk(session, plan.assets[0].id, 0, body.subarray(0, 4));

    const restored = targetSession(session.id);
    await expect(store.hydrateSession(restored)).resolves.toBe(true);
    expect(store.getPlan(restored).assets[0]).toMatchObject({ offset: 4, state: "receiving" });
    await store.writeAssetChunk(restored, plan.assets[0].id, 4, body.subarray(4));
    expect(store.getPlan(restored)).toMatchObject({ status: "assets-ready", remainingBytes: 0 });
  });

  it("revalidates completed asset files while hydrating", async () => {
    const store = await tempStore();
    const session = targetSession("restart-corrupt-asset");
    const body = Buffer.from("good");
    const plan = await store.planAssets(
      session,
      [{ key: "assets/check.bin", size: body.length, sha256: sha256(body) }],
      { openReadStream: async () => ({ exists: false }) },
    );
    await store.writeAssetChunk(session, plan.assets[0].id, 0, body);
    await fs.promises.writeFile(store.assetPath(session.id, plan.assets[0].id), Buffer.from("evil"));

    const restored = targetSession(session.id);
    await store.hydrateSession(restored);
    expect(store.getPlan(restored).assets[0]).toMatchObject({ offset: 0, state: "pending" });
  });

});
