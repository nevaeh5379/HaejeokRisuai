import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");
const protocol = resolve(root, "packages/protocol");
const output = resolve(protocol, "dist");

/** Generate frontend setting-key types; runtime modules use their TS sources. */
export function buildProtocol({
  force = false,
}: { force?: boolean } = {}): void {
  const inputs = [scriptPath, resolve(protocol, "settings.json")];
  const outputs = [resolve(output, "settingKeys.d.ts")];
  const latestInput = Math.max(...inputs.map((path) => statSync(path).mtimeMs));
  if (
    !force &&
    outputs.every(
      (path) => existsSync(path) && statSync(path).mtimeMs >= latestInput,
    )
  )
    return;

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
