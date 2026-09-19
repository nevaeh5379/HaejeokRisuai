import { mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeServerDir = resolve(root, "server/node");
const distDir = resolve(nodeServerDir, "dist");
const backupCoreBuild = resolve(root, "packages/backup-core/build.mjs");

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const backupCoreResult = spawnSync(process.execPath, [backupCoreBuild], {
  cwd: root,
  stdio: "inherit",
});
if (backupCoreResult.error) throw backupCoreResult.error;
if (backupCoreResult.status !== 0) {
  process.exit(backupCoreResult.status ?? 1);
}

/**
 * Bundles the Node server (server/node) into single-file outputs in
 * server/node/dist.
 *
 * - All local .cjs/.cts modules are inlined, so the outputs have no relative
 *   require back into the source tree.
 * - node_modules packages and workspace packages (packages/*) stay external:
 *   they are shipped alongside the app in every deploy target.
 * - `__dirname` is replaced at build time with the absolute folder of the
 *   source file using it, because storage backends read sibling SQL schema
 *   files (e.g. storage/postgres/postgres-schema.sql) and vendor .env files
 *   that live in the source tree.
 */

function externalizePackages() {
  return {
    name: "externalize-packages",
    setup(build) {
      // Workspace packages are built separately and shipped alongside.
      build.onResolve({ filter: /^(\.\.\/)*packages\// }, (args) => {
        if (args.path.startsWith(".")) return null;
        return { path: args.path, external: true };
      });
      // Bare specifiers (node_modules) stay external.
      build.onResolve({ filter: /^[^./]/ }, (args) => ({
        path: args.path,
        external: true,
      }));
    },
  };
}

function dirnamesAtBuildTime() {
  return {
    name: "dirnames-at-build-time",
    setup(build) {
      build.onLoad({ filter: /\.(c|m)?[jt]s$/ }, async (args) => {
        let contents = await readFile(args.path, "utf8");
        if (contents.includes("__dirname")) {
          contents = contents.replaceAll(
            "__dirname",
            JSON.stringify(dirname(args.path)),
          );
        }
        const isTypeScript = /\.(c|m)?ts$/.test(args.path);
        return {
          contents,
          loader: isTypeScript ? "ts" : "js",
        };
      });
    },
  };
}

async function bundle({ entry, outfile }) {
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: false,
    logLevel: "info",
    outExtension: { ".js": ".cjs" },
    plugins: [externalizePackages(), dirnamesAtBuildTime()],
  });
}

await bundle({
  entry: resolve(nodeServerDir, "server.cts"),
  outfile: resolve(distDir, "server.cjs"),
});

await bundle({
  entry: resolve(nodeServerDir, "http/realtimeEvents.cts"),
  outfile: resolve(distDir, "http/realtimeEvents.cjs"),
});

await bundle({
  entry: resolve(nodeServerDir, "sync/databaseMutations.cts"),
  outfile: resolve(distDir, "databaseMutations.cjs"),
});

await bundle({
  entry: resolve(nodeServerDir, "sync/storageSyncSqlApply.cts"),
  outfile: resolve(distDir, "storageSyncSqlApply.cjs"),
});

console.log("Node server bundle build: OK");
