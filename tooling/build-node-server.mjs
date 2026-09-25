import { mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
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
 * - `__dirname` references are rewritten to runtime-relative source
 *   directories. Relocated bundles (for example the Termux archive) therefore
 *   resolve schemas and vendor .env files from the extracted installation
 *   instead of embedding the CI checkout path.
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

function runtimeRelativeDirnames(bundleDirectory) {
  return {
    name: "runtime-relative-dirnames",
    setup(build) {
      build.onLoad({ filter: /\.(c|m)?[jt]s$/ }, async (args) => {
        let contents = await readFile(args.path, "utf8");
        if (contents.includes("__dirname")) {
          const sourceDirectory = dirname(args.path);
          const fromBundleDirectory = relative(bundleDirectory, sourceDirectory);
          const runtimeDirectory = fromBundleDirectory
            ? `require("node:path").resolve(__dirname, ${JSON.stringify(fromBundleDirectory)})`
            : "__dirname";
          contents = contents.replaceAll("__dirname", `(${runtimeDirectory})`);
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
    plugins: [externalizePackages(), runtimeRelativeDirnames(dirname(outfile))],
  });
}

await bundle({
  entry: resolve(nodeServerDir, "server.cts"),
  outfile: resolve(distDir, "server.cjs"),
});

await bundle({
  entry: resolve(nodeServerDir, "executors/modelJobs.cts"),
  outfile: resolve(distDir, "executors/modelJobs.cjs"),
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
