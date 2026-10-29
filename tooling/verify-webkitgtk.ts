import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const toolingDirectory = dirname(fileURLToPath(import.meta.url));
const pin: { version: string; sha256: string } = JSON.parse(
  readFileSync(join(toolingDirectory, "webkitgtk-version.json"), "utf8"),
);

function findFiles(
  root: string,
  names: ReadonlySet<string>,
): Map<string, string[]> {
  const files = new Map<string, string[]>();
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (names.has(entry.name) && statSync(path).isFile()) {
        const matches = files.get(entry.name) ?? [];
        matches.push(path);
        files.set(entry.name, matches);
      }
    }
  };
  visit(join(root, "usr"));
  return files;
}

function run(command: string, args: string[], env = process.env): string {
  const result = spawnSync(command, args, { encoding: "utf8", env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

function buildId(path: string): string {
  const id = run("readelf", ["--notes", path]).match(
    /Build ID: ([0-9a-f]+)/,
  )?.[1];
  if (!id) throw new Error(`Missing ELF build ID: ${path}`);
  return id;
}

/** Check the actual libraries loaded from a staged installation or AppDir. */
export function verifyWebkitGtk(root: string, referenceRoot?: string): string {
  const required = new Set([
    "libwebkit2gtk-4.1.so.0",
    "libjavascriptcoregtk-4.1.so.0",
    "WebKitWebProcess",
    "WebKitNetworkProcess",
    "WebKitGPUProcess",
    "libwebkit2gtkinjectedbundle.so",
  ]);
  const reference = referenceRoot ? findFiles(referenceRoot, required) : null;
  const compilerLibraries = new Set(["libstdc++.so.6", "libgcc_s.so.1"]);
  // Staged libraries use the build host's runtime. The portable AppImage must
  // include the newer compiler runtime, which linuxdeploy normally excludes.
  if (referenceRoot) {
    for (const name of compilerLibraries) required.add(name);
  }
  const files = findFiles(root, required);
  for (const name of required) {
    const matches = files.get(name);
    if (!matches?.length)
      throw new Error(`Missing WebKitGTK runtime file: ${name}`);
    for (const path of matches) {
      if (name.startsWith("WebKit") && !(statSync(path).mode & 0o111)) {
        throw new Error(`WebKitGTK helper is not executable: ${path}`);
      }
      if (reference && !compilerLibraries.has(name)) {
        const expected = reference.get(name);
        if (expected?.length !== 1)
          throw new Error(`Ambiguous reference file: ${name}`);
        // linuxdeploy changes RPATHs; ELF build IDs survive this relocation.
        if (buildId(path) !== buildId(expected[0])) {
          throw new Error(
            `WebKitGTK runtime does not match the pinned build: ${path}`,
          );
        }
      }
    }
  }

  const libraries = [
    "libwebkit2gtk-4.1.so.0",
    "libjavascriptcoregtk-4.1.so.0",
  ].map((name) => {
    const matches = files.get(name)!;
    if (matches.length !== 1)
      throw new Error(`Ambiguous runtime library: ${name}`);
    return matches[0];
  });
  const temporary = mkdtempSync(join(tmpdir(), "risu-webkit-version-"));
  try {
    const probe = join(temporary, "probe");
    run("cc", [
      join(toolingDirectory, "webkitgtk-version-probe.c"),
      "-o",
      probe,
      "-ldl",
    ]);
    const libraryDirectories = [...new Set(libraries.map(dirname))];
    return run(probe, [pin.version, ...libraries], {
      ...process.env,
      LD_LIBRARY_PATH: libraryDirectories.join(":"),
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [root, referenceRoot] = process.argv.slice(2);
  if (!root)
    throw new Error("Usage: verify-webkitgtk.ts APPDIR [STAGED_INSTALLATION]");
  console.log(
    verifyWebkitGtk(resolve(root), referenceRoot && resolve(referenceRoot)),
  );
}
