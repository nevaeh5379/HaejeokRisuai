import { resolve } from "node:path";
import ts from "typescript";

// The legacy storage implementations are checked by the regular server tsc
// command. Enforce noImplicitAny on the migrated entry point independently so
// untyped dependencies do not prevent tightening this file's type checking.
const configPath = resolve("server/node/tsconfig.server.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  resolve("server/node"),
  { noEmit: true, noImplicitAny: true },
  configPath,
);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const files = ["server/node/server.ts", "server/node/serverTypes.ts"];
const diagnostics = [
  ...(config.error ? [config.error] : []),
  ...parsed.errors,
  ...program.getOptionsDiagnostics(),
  ...program.getGlobalDiagnostics(),
];
for (const file of files) {
  const source = program.getSourceFile(resolve(file));
  if (!source) throw new Error(`Type-check entry point is missing: ${file}`);
  diagnostics.push(
    ...program.getSyntacticDiagnostics(source),
    ...program.getSemanticDiagnostics(source),
  );
}
if (diagnostics.length) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getNewLine: () => ts.sys.newLine,
    }),
  );
  process.exitCode = 1;
} else {
  console.log("Node server entry-point types: no implicit any");
}
