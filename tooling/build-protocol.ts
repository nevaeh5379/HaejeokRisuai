import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");
const protocol = resolve(root, "packages/protocol");
const output = resolve(protocol, "dist");
const require = createRequire(import.meta.url);
const browserModules = [
  "illustration",
  "illustrationRunner",
  "illustrationStorage",
  "imageGeneration",
] as const;

// Keep the Node CommonJS entry points while serving real ES modules to Vite.
// Local CommonJS dependency optimization can be bypassed after an HMR update.
function emitBrowserModules(): void {
  const esmImports: ts.TransformerFactory<ts.SourceFile> =
    (context) => (source) =>
      ts.visitEachChild(
        source,
        function visit(node): ts.Node {
          if (
            ts.isImportDeclaration(node) &&
            ts.isStringLiteral(node.moduleSpecifier) &&
            node.moduleSpecifier.text.startsWith("./") &&
            node.moduleSpecifier.text.endsWith(".cjs")
          )
            return context.factory.updateImportDeclaration(
              node,
              node.modifiers,
              node.importClause,
              context.factory.createStringLiteral(
                node.moduleSpecifier.text.replace(/\.cjs$/, ".mjs"),
              ),
              node.attributes,
            );
          return ts.visitEachChild(node, visit, context);
        },
        context,
      );

  for (const name of browserModules) {
    const source = readFileSync(
      resolve(protocol, "src", `${name}.cts`),
      "utf8",
    );
    const compiled = ts.transpileModule(source, {
      fileName: `${name}.mts`,
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.ESNext,
      },
      transformers: { before: [esmImports] },
    });
    writeFileSync(resolve(output, `${name}.mjs`), compiled.outputText);
    writeFileSync(
      resolve(output, `${name}.d.mts`),
      readFileSync(resolve(output, `${name}.d.cts`), "utf8").replaceAll(
        '.cjs"',
        '.mjs"',
      ),
    );
  }
}

/** Compile only when needed by development; explicit builds always type-check. */
export function buildProtocol({
  force = false,
}: { force?: boolean } = {}): void {
  const sources = readdirSync(resolve(protocol, "src")).filter((name) =>
    name.endsWith(".cts"),
  );
  const inputs = [
    scriptPath,
    resolve(protocol, "settings.json"),
    resolve(protocol, "tsconfig.json"),
    ...sources.map((name) => resolve(protocol, "src", name)),
  ];
  const outputs = [
    resolve(output, "settingKeys.d.ts"),
    ...browserModules.flatMap((name) => [
      resolve(output, `${name}.mjs`),
      resolve(output, `${name}.d.mts`),
    ]),
    ...sources.flatMap((name) => [
      resolve(output, name.replace(/\.cts$/, ".cjs")),
      resolve(output, name.replace(/\.cts$/, ".d.cts")),
    ]),
  ];
  const latestInput = Math.max(...inputs.map((path) => statSync(path).mtimeMs));
  if (
    !force &&
    outputs.every(
      (path) => existsSync(path) && statSync(path).mtimeMs >= latestInput,
    )
  )
    return;

  const result = spawnSync(
    process.execPath,
    [
      require.resolve("typescript/bin/tsc"),
      "-p",
      resolve(protocol, "tsconfig.json"),
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error("Protocol TypeScript compilation failed");

  emitBrowserModules();

  const settings = JSON.parse(
    readFileSync(resolve(protocol, "settings.json"), "utf8"),
  ) as Record<string, unknown>;
  const types = [
    "// Generated from settings.json by tooling/build-protocol.ts. Do not edit.",
    "export type ProtocolSettingKeys = {",
    ...Object.entries(settings).map(([name, keys]) => {
      if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string"))
        throw new Error(`Invalid protocol setting keys: ${name}`);
      return `  ${name}:\n${keys.map((key) => `    | ${JSON.stringify(key)}`).join("\n")};`;
    }),
    "};",
    "",
  ].join("\n");
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, "settingKeys.d.ts"), types);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath)
  buildProtocol({ force: true });
