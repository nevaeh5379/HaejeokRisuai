"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const generatedServer = path.join(__dirname, "server.cjs");
const generatedMutations = path.join(__dirname, "databaseMutations.cjs");
const serverSource = path.join(__dirname, "server.cts");
const mutationSource = path.join(__dirname, "databaseMutations.cts");

function isStale(source, output) {
  if (!fs.existsSync(output)) return true;
  return fs.statSync(source).mtimeMs > fs.statSync(output).mtimeMs;
}

const needsBuild =
  !fs.existsSync(generatedServer) ||
  !fs.existsSync(generatedMutations) ||
  (process.env.NODE_ENV !== "production" &&
    (isStale(serverSource, generatedServer) ||
      isStale(mutationSource, generatedMutations)));

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
