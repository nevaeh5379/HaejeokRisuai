import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)));
const outDir = resolve(root, "dist");
const config = resolve(root, "tsconfig.build.json");
const tsc = require.resolve("typescript/bin/tsc");

rmSync(outDir, { recursive: true, force: true });
const result = spawnSync(process.execPath, [tsc, "-p", config], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

mkdirSync(outDir, { recursive: true });
writeFileSync(
  resolve(outDir, "package.json"),
  `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`,
);
