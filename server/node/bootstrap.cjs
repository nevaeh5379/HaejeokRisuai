"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const generatedServer = path.join(__dirname, "server.cjs");
const generatedMutations = path.join(__dirname, "databaseMutations.cjs");
const generatedStorageSyncApply = path.join(
  __dirname,
  "storageSyncSqlApply.cjs",
);
const serverSource = path.join(__dirname, "server.cts");
const mutationSource = path.join(__dirname, "databaseMutations.cts");
const storageSyncApplySource = path.join(
  __dirname,
  "storageSyncSqlApply.cts",
);
const backupCoreRoot = path.join(root, "packages/backup-core");
const backupCoreOutputs = [
  path.join(backupCoreRoot, "dist/assetScope.js"),
  path.join(backupCoreRoot, "dist/compatibility.js"),
  path.join(backupCoreRoot, "dist/entryPolicy.js"),
  path.join(backupCoreRoot, "dist/portableBranches.js"),
  path.join(backupCoreRoot, "dist/api.js"),
  path.join(backupCoreRoot, "dist/node/databaseStreamStore.js"),
  path.join(backupCoreRoot, "dist/node/exportJobStore.js"),
  path.join(backupCoreRoot, "dist/node/legacyFormat.js"),
];
const backupCoreSources = [
  path.join(backupCoreRoot, "build.mjs"),
  path.join(backupCoreRoot, "package.json"),
  path.join(backupCoreRoot, "src/api.ts"),
  path.join(backupCoreRoot, "src/assetScope.ts"),
  path.join(backupCoreRoot, "src/compatibility.ts"),
  path.join(backupCoreRoot, "src/entryPolicy.ts"),
  path.join(backupCoreRoot, "src/portableBranches.ts"),
  path.join(backupCoreRoot, "src/node/databaseStreamStore.ts"),
  path.join(backupCoreRoot, "src/node/exportJobStore.ts"),
  path.join(backupCoreRoot, "src/node/legacyFormat.ts"),
];

function isStale(source, output) {
  if (!fs.existsSync(output)) return true;
  return fs.statSync(source).mtimeMs > fs.statSync(output).mtimeMs;
}

const backupCoreNeedsBuild =
  backupCoreOutputs.some((output) => !fs.existsSync(output)) ||
  (process.env.NODE_ENV !== "production" &&
    backupCoreSources.some((source) =>
      backupCoreOutputs.some((output) => isStale(source, output)),
    ));

const needsBuild =
  !fs.existsSync(generatedServer) ||
  !fs.existsSync(generatedMutations) ||
  !fs.existsSync(generatedStorageSyncApply) ||
  backupCoreNeedsBuild ||
  (process.env.NODE_ENV !== "production" &&
    (isStale(serverSource, generatedServer) ||
      isStale(mutationSource, generatedMutations) ||
      isStale(storageSyncApplySource, generatedStorageSyncApply)));

if (needsBuild) {
  const builder = path.join(root, "tooling/build-node-server.mjs");
  if (!fs.existsSync(builder)) {
    throw new Error(
      "Generated Node server is missing and build tooling is unavailable",
    );
  }
  const result = spawnSync(process.execPath, [builder], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

require(generatedServer);
