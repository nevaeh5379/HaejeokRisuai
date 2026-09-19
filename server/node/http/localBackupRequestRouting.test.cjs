const assert = require("node:assert/strict");
const test = require("node:test");
const {
  isLocalBackupImportFinalizePath,
  isLocalBackupImportUploadPath,
} = require("./localBackupRequestRouting.cjs");

test("local backup upload routing preserves streaming bodies", () => {
  assert.equal(
    isLocalBackupImportUploadPath("/api/local-backup/import/jobs/job-1/file"),
    true,
  );
  assert.equal(
    isLocalBackupImportUploadPath("/api/local-backup/import/jobs/job-1/chunks"),
    true,
  );
  assert.equal(
    isLocalBackupImportUploadPath(
      "/api/local-backup/import/jobs/job-1/finalize-upload",
    ),
    false,
  );
});

test("chunked import finalize bypasses the reader gate", () => {
  assert.equal(
    isLocalBackupImportFinalizePath(
      "/api/local-backup/import/jobs/job-1/finalize-upload",
    ),
    true,
  );
  assert.equal(
    isLocalBackupImportFinalizePath("/api/local-backup/import/jobs/job-1/chunks"),
    false,
  );
});
