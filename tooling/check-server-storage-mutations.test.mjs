import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkServerStorageMutations } from "./check-server-storage-mutations.mjs";

function withFixture(source, run) {
  const dir = mkdtempSync(join(tmpdir(), "risu-mutation-policy-"));
  const file = join(dir, "server.cjs");
  writeFileSync(file, source);
  try {
    return run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("allows classified reads and internal writes", () => {
  withFixture(
    `postgresStorage.loadChat("chat");\npostgresStorage.upsertAssetCatalog([]);`,
    (file) => assert.equal(checkServerStorageMutations(file), true),
  );
});

test("rejects direct client-visible writes", () => {
  withFixture(`postgresStorage.saveMessage("chat", {});`, (file) => {
    assert.throws(
      () => checkServerStorageMutations(file),
      /saveMessage\(\).*must go through databaseMutations/,
    );
  });
});

test("rejects unclassified storage calls", () => {
  withFixture(`postgresStorage.futureWrite({});`, (file) => {
    assert.throws(
      () => checkServerStorageMutations(file),
      /unclassified postgresStorage\.futureWrite\(\)/,
    );
  });
});
