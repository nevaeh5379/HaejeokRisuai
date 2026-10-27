import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import ts from "typescript";

// Shared code under packages/ is the leaf of the dependency graph: it must never
// reach into the application under src/, otherwise "shared" code silently stops
// being reusable by the Node server, plugins, or a future server implementation.
const root = resolve(import.meta.dirname, "..");
const appSource = resolve(root, "src");
const packageFiles: string[] = [];

async function walk(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name.endsWith(".ts")) packageFiles.push(path);
  }
}

await walk(resolve(root, "packages"));

const offenders: string[] = [];
for (const file of packageFiles) {
  const source = ts.createSourceFile(
    file,
    await readFile(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers: string[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const specifier of specifiers) {
    if (specifier === "src" || specifier.startsWith("src/")) {
      offenders.push(`${relative(root, file)}: ${specifier}`);
      continue;
    }
    if (!specifier.startsWith(".")) continue;
    const target = resolve(file, "..", specifier.split("?")[0]);
    const insideApp = relative(appSource, target);
    if (insideApp !== "" && !insideApp.startsWith(".."))
      offenders.push(`${relative(root, file)}: ${specifier}`);
  }
}

if (offenders.length) {
  console.error(
    `Packages must not import application source:\n${offenders.join("\n")}`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `Package import boundaries: OK (${packageFiles.length} shared files, no src/ imports)`,
  );
}
