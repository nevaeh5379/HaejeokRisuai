import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const vitePackage = require.resolve("vite/package.json");
const viteBin = join(dirname(vitePackage), "bin", "vite.js");

// Tailwind CSS 4.2.2 still calls module.register(), which Node 24 deprecates.
// Suppress only DEP0205 until the upstream package moves to registerHooks().
const result = spawnSync(
  process.execPath,
  ["--disable-warning=DEP0205", viteBin, "build", ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env },
);

if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
