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

/**
 * Emits browser ESM and declarations from the same TypeScript sources as the Node CommonJS modules.
 *
 * 한국어: Node CommonJS와 동일한 TypeScript 원본에서 브라우저 ESM·타입 선언을 생성하는 함수.
 *
 * @remarks
 * Rewrites relative CommonJS import specifiers for ESM without changing runtime strings.
 * Real ESM remains importable when Vite HMR bypasses CommonJS dependency optimization.
 * 한국어: 런타임 문자열 변경 없이 상대 CommonJS import 경로만 ESM 경로로 치환.
 * Vite HMR에서 CommonJS 의존성 최적화를 건너뛰어도 직접 불러올 수 있는 ESM 생성.
 */
function emitBrowserModules(): void {
  /**
   * Creates an import-only AST transformer for the generated browser modules.
   *
   * 한국어: 생성할 브라우저 모듈의 import 선언만 수정하는 AST 변환기를 만드는 함수.
   */
  const esmImports: ts.TransformerFactory<ts.SourceFile> =
    (context) => (source) =>
      ts.visitEachChild(
        source,
        /**
         * Visits the AST and rewrites only relative import declarations ending in .cjs.
         *
         * 한국어: AST를 순회하며 .cjs로 끝나는 상대 import 선언만 바꾸는 함수.
         */
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

/**
 * Builds protocol runtime/declaration outputs and generated setting-key types.
 *
 * 한국어: 프로토콜 실행 파일·타입 선언·설정 키 타입을 생성하는 함수.
 *
 * @remarks
 * Development calls skip up-to-date outputs; force builds always run TypeScript checking.
 * Emits both Node CommonJS and browser ESM entry points for illustration modules.
 * 한국어: 개발 호출은 최신 출력이면 생략하고 강제 빌드는 항상 TypeScript 검증을 실행.
 * 삽화 모듈은 Node CommonJS·브라우저 ESM 진입점을 함께 생성.
 * @throws When TypeScript compilation or setting-key validation fails. / TypeScript 컴파일·설정 키 검증 실패 시.
 */
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
