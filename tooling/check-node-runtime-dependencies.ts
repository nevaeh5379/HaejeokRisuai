import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, resolve, extname } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  await readFile(resolve(root, "server/node/package.json"), "utf8"),
);
const declared = new Set(Object.keys(manifest.dependencies ?? {}));
const builtins = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
);
const visited = new Set<string>();
const dependencies = new Set<string>();
async function inspect(file: string): Promise<void> {
  if (visited.has(file)) return;
  visited.add(file);
  if (extname(file) === ".json") return;
  const source = ts.createSourceFile(
    file,
    await readFile(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports: string[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      !node.importClause?.isTypeOnly &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const bindings = node.importClause?.namedBindings;
      if (
        !bindings ||
        !ts.isNamedImports(bindings) ||
        bindings.elements.some((item) => !item.isTypeOnly)
      )
        imports.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      if (!ts.isStringLiteral(node.arguments[0]))
        throw new Error(`Nonliteral runtime import in ${file}`);
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const specifier of imports) {
    if (builtins.has(specifier)) continue;
    if (specifier.startsWith(".")) {
      if (!/\.(ts|json)$/.test(specifier))
        throw new Error(
          `Runtime source extension missing: ${file}: ${specifier}`,
        );
      await inspect(resolve(dirname(file), specifier));
    } else
      dependencies.add(
        specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0],
      );
  }
}
await inspect(resolve(root, "server/node/server.ts"));
const missing = [...dependencies].filter((name) => !declared.has(name));
const unused = [...declared].filter((name) => !dependencies.has(name));
if (missing.length || unused.length)
  throw new Error(
    `Node runtime dependency manifest mismatch (missing: ${missing.join(", ")}; unused: ${unused.join(", ")})`,
  );
console.log(
  `Node runtime source dependencies: OK (${visited.size} files, ${dependencies.size} packages)`,
);
