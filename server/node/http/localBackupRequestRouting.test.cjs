const assert = require("node:assert/strict");
const test = require("node:test");
const {
  isLocalBackupImportControlPath,
  isLocalBackupImportFinalizePath,
  isLocalBackupImportUploadPath,
  isReadOnlyRequestMethod,
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

test("chunked import finalize controls restore mode", () => {
  assert.equal(
    isLocalBackupImportFinalizePath(
      "/api/local-backup/import/jobs/job-1/finalize-upload",
    ),
    true,
  );
  assert.equal(
    isLocalBackupImportFinalizePath(
      "/api/local-backup/import/jobs/job-1/chunks",
    ),
    false,
  );
});

test("direct import controls restore mode before finalizing in-request", () => {
  assert.equal(
    isLocalBackupImportControlPath("/api/local-backup/import/jobs/job-1/file"),
    true,
  );
  assert.equal(
    isLocalBackupImportControlPath(
      "/api/local-backup/import/jobs/job-1/finalize-upload",
    ),
    true,
  );
  assert.equal(
    isLocalBackupImportControlPath(
      "/api/local-backup/import/jobs/job-1/chunks",
    ),
    false,
  );
});

test("restore mode permits reads and gates mutations without route allowlists", () => {
  assert.equal(isReadOnlyRequestMethod("GET"), true);
  assert.equal(isReadOnlyRequestMethod("HEAD"), true);
  assert.equal(isReadOnlyRequestMethod("OPTIONS"), true);
  assert.equal(isReadOnlyRequestMethod("POST"), false);
  assert.equal(isReadOnlyRequestMethod("PUT"), false);
  assert.equal(isReadOnlyRequestMethod("PATCH"), false);
  assert.equal(isReadOnlyRequestMethod("DELETE"), false);
});
