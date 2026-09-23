import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ServerPackage {
  dependencies?: Record<string, string>;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverPackagePath = resolve(root, "server/node/package.json");
const serverBundlePath = resolve(root, "server/node/dist/server.cjs");

const [serverPackageSource, serverBundle] = await Promise.all([
  readFile(serverPackagePath, "utf8"),
  readFile(serverBundlePath, "utf8"),
]);
const serverPackage = JSON.parse(serverPackageSource) as ServerPackage;
const declaredDependencies = new Set(
  Object.keys(serverPackage.dependencies ?? {}),
);
const builtins = new Set(
  builtinModules.flatMap((name) => [name, name.replace(/^node:/, "")]),
);

function packageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/");
  }
  return specifier.split("/", 1)[0];
}

const runtimeDependencies = new Set<string>();
for (const match of serverBundle.matchAll(/require\(["']([^"']+)["']\)/g)) {
  const specifier = match[1];
  const normalizedBuiltin = specifier.replace(/^node:/, "");
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    builtins.has(specifier) ||
    builtins.has(normalizedBuiltin)
  ) {
    continue;
  }
  runtimeDependencies.add(packageName(specifier));
}

const missing = [...runtimeDependencies]
  .filter((name) => !declaredDependencies.has(name))
  .sort();
const unused = [...declaredDependencies]
  .filter((name) => !runtimeDependencies.has(name))
  .sort();

if (missing.length || unused.length) {
  const details: string[] = [];
  if (missing.length) details.push(`missing: ${missing.join(", ")}`);
  if (unused.length) details.push(`unused: ${unused.join(", ")}`);
  throw new Error(
    `server/node/package.json does not match the generated server bundle (${details.join("; ")})`,
  );
}

console.log(
  `Node runtime dependency manifest: OK (${runtimeDependencies.size} packages)`,
);
