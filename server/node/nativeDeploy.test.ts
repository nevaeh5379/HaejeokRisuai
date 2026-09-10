import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { summarizeUserAssets } = require("../../tooling/native-deploy.cjs");
const roots: string[] = [];

function hexKey(key: string): string {
  return Buffer.from(key, "utf8").toString("hex");
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("native user asset summary", () => {
  it("counts persisted user assets separately from frontend files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "risu-native-assets-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, hexKey("assets/a.png")), Buffer.alloc(3));
    fs.writeFileSync(
      path.join(root, hexKey("assets/nested/b.webp")),
      Buffer.alloc(5),
    );
    fs.writeFileSync(
      path.join(root, hexKey("database/database.bin")),
      Buffer.alloc(7),
    );
    fs.writeFileSync(path.join(root, "__password"), "password");

    expect(summarizeUserAssets(root)).toMatchObject({
      objects: 2,
      bytes: 8,
      savePath: path.resolve(root),
    });
  });
});
