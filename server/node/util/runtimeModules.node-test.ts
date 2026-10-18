import assert from "node:assert/strict";
import test from "node:test";
import {
  lazyModule,
  loadPostgres,
  loadOracle,
  loadMssql,
  loadS3,
  loadSharp,
  loadOpenid,
} from "./runtimeModules.ts";
import { countTokensBatch, disposeEncoders } from "./tokenizeCount.ts";
import { createStorageDriver } from "../storage/storageDriver.ts";
import { S3AssetStorage } from "../storage/assetStorage.ts";

test("lazy modules share concurrent loads and retry after a shared failure", async () => {
  let attempts = 0;
  let finish: (value: object) => void;
  const load = lazyModule(() => {
    attempts++;
    return attempts === 1
      ? Promise.reject(new Error("unavailable"))
      : new Promise<object>((resolve) => {
          finish = resolve;
        });
  });
  const failed = load();
  assert.equal(load(), failed);
  await assert.rejects(failed, /unavailable/);
  const retry = load();
  assert.equal(load(), retry);
  const value = {};
  finish!(value);
  assert.equal(await retry, value);
  assert.equal(await load(), value);
  assert.equal(attempts, 2);
});

test("first concurrent token calls work without a loader for both encodings", async () => {
  try {
    assert.deepEqual(
      await Promise.all([
        countTokensBatch(["hello world"], "cl100k_base"),
        countTokensBatch(["hello world"], "cl100k_base"),
        countTokensBatch(["안녕하세요"], "o200k_base"),
      ]),
      [[2], [2], [2]],
    );
    await assert.rejects(
      countTokensBatch(["hello"], "invalid"),
      /Unsupported tokenizer/,
    );
  } finally {
    disposeEncoders();
  }
});

test("SQL factories load each vendor with synchronous constructors", async () => {
  for (const vendor of ["postgres", "oracle", "azure"] as const) {
    const [first, second] = await Promise.all([
      createStorageDriver({ vendor, enabled: false }),
      createStorageDriver({ vendor, enabled: false }),
    ]);
    assert.equal(first.constructor.name.toLowerCase(), `${vendor}storage`);
    assert.equal(second.constructor.name, first.constructor.name);
    assert.notEqual(first, second);
    await Promise.all([first.close?.(), second.close?.()]);
  }
  assert.equal(typeof (await loadPostgres()).Pool, "function");
  assert.equal(typeof (await loadOracle()).getConnection, "function");
  assert.equal(typeof (await loadMssql()).ConnectionPool, "function");
});

test("S3, image and OIDC modules expose usable ESM APIs", async () => {
  const [s3, sharp, oidc] = await Promise.all([
    loadS3(),
    loadSharp(),
    loadOpenid(),
  ]);
  assert.equal(await loadS3(), s3);
  assert.equal(typeof s3.Upload, "function");
  const storage = new S3AssetStorage({ bucket: "test", region: "us-east-1" });
  assert.equal(storage.client, null);
  await Promise.all([storage.ensureClient(), storage.ensureClient()]);
  const client = storage.client;
  await storage.ensureClient();
  assert.equal(storage.client, client);
  client.destroy();
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  assert.equal((await sharp(png).metadata()).width, 2);
  const verifier = oidc.randomPKCECodeVerifier();
  assert.equal(
    typeof (await oidc.calculatePKCECodeChallenge(verifier)),
    "string",
  );
});
