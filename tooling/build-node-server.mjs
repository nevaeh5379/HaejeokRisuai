import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = resolve(root, "server/node/tsconfig.server.json");
const outDir = resolve(root, "server/node/.tsbuild");
const tsc = require.resolve("typescript/bin/tsc");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const result = spawnSync(process.execPath, [tsc, "-p", config], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

for (const file of ["server.cjs", "databaseMutations.cjs"]) {
  copyFileSync(resolve(outDir, file), resolve(root, "server/node", file));
}
rmSync(outDir, { recursive: true, force: true });
console.log("Node server TypeScript build: OK");
