import { readFileSync, writeFileSync } from "node:fs";

const source = new URL("../packages/protocol/settings.json", import.meta.url);
const target = new URL("../packages/protocol/settingKeys.d.ts", import.meta.url);
const settings = JSON.parse(readFileSync(source, "utf8"));
const expected = [
  "// Generated from settings.json by tooling/protocol-setting-types.mjs --write.",
  "// Do not edit: pnpm check verifies that runtime and type ownership agree.",
  "export type ProtocolSettingKeys = {",
  ...Object.entries(settings).map(([name, keys]) =>
    `  ${name}:\n${keys.map((key) => `    | ${JSON.stringify(key)}`).join("\n")};`,
  ),
  "};",
  "",
].join("\n");

if (process.argv.includes("--write")) {
  writeFileSync(target, expected);
} else {
  let actual;
  try {
    actual = readFileSync(target, "utf8");
  } catch {
    actual = "";
  }
  if (actual !== expected) {
    console.error(
      "Protocol setting types are stale. Run node tooling/protocol-setting-types.mjs --write",
    );
    process.exitCode = 1;
  }
}
