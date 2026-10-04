import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyWebkitGtk } from "./verify-webkitgtk";

const linux = { skip: process.platform !== "linux" };
const pinnedVersion: string = JSON.parse(
  readFileSync(new URL("./webkitgtk-version.json", import.meta.url), "utf8"),
).version;
const versionPattern = pinnedVersion.replaceAll(".", "\\.");

function compile(path: string, code: string, shared = false) {
  const source = `${path}.c`;
  writeFileSync(source, code);
  const result = spawnSync("cc", [
    ...(shared ? ["-shared", "-fPIC"] : []),
    "-Wl,--build-id",
    source,
    "-o",
    path,
  ]);
  assert.equal(result.status, 0, result.stderr?.toString());
  rmSync(source);
}

function runtime(
  root: string,
  webkit = pinnedVersion,
  javascriptCore = pinnedVersion,
) {
  const lib = join(root, "usr/lib");
  mkdirSync(lib, { recursive: true });
  for (const [name, prefix, version] of [
    ["libwebkit2gtk-4.1.so.0", "webkit", webkit],
    ["libjavascriptcoregtk-4.1.so.0", "jsc", javascriptCore],
  ]) {
    const parts = version.split(".");
    compile(
      join(lib, name),
      ["major", "minor", "micro"]
        .map(
          (part, i) =>
            `unsigned ${prefix}_get_${part}_version(void) { return ${parts[i]}; }`,
        )
        .join("\n"),
      true,
    );
  }
  for (const name of [
    "WebKitWebProcess",
    "WebKitNetworkProcess",
    "WebKitGPUProcess",
  ]) {
    compile(join(lib, name), "int main(void) { return 0; }");
  }
  compile(
    join(lib, "libwebkit2gtkinjectedbundle.so"),
    "int injected(void) { return 0; }",
    true,
  );
}

function temporary(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "risu-webkit-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function compilerRuntime(root: string) {
  for (const name of ["libstdc++.so.6", "libgcc_s.so.1"]) {
    const result = spawnSync("c++", [`-print-file-name=${name}`], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    cpSync(realpathSync(result.stdout.trim()), join(root, "usr/lib", name));
  }
}

test(
  "loads both bundled libraries and rejects an old WebKit or mismatched JavaScriptCore",
  linux,
  (t) => {
    const root = temporary(t);
    runtime(root);
    assert.match(verifyWebkitGtk(root), new RegExp(versionPattern));
    runtime(root, "2.50.4");
    assert.throws(
      () => verifyWebkitGtk(root),
      new RegExp(`Expected ${versionPattern}, found 2\\.50\\.4`),
    );
    runtime(root, pinnedVersion, "2.52.6");
    assert.throws(
      () => verifyWebkitGtk(root),
      new RegExp(`Expected ${versionPattern}, found 2\\.52\\.6`),
    );
  },
);

test("rejects missing or non-executable subprocesses", linux, (t) => {
  const root = temporary(t);
  runtime(root);
  const helper = join(root, "usr/lib/WebKitNetworkProcess");
  chmodSync(helper, 0o644);
  assert.throws(() => verifyWebkitGtk(root), /helper is not executable/);
  rmSync(helper);
  assert.throws(
    () => verifyWebkitGtk(root),
    /Missing WebKitGTK runtime file: WebKitNetworkProcess/,
  );
});

test(
  "detects helpers from a different build even when library versions match",
  linux,
  (t) => {
    const root = temporary(t);
    const stage = join(root, "stage");
    const app = join(root, "app");
    runtime(stage);
    cpSync(stage, app, { recursive: true });
    compilerRuntime(app);
    assert.match(verifyWebkitGtk(app, stage), new RegExp(versionPattern));
    compile(
      join(app, "usr/lib/WebKitNetworkProcess"),
      "int main(void) { return 1; }",
    );
    assert.throws(
      () => verifyWebkitGtk(app, stage),
      /does not match the pinned build/,
    );
  },
);

test(
  "requires the GPU process in both the staged build and the AppImage",
  linux,
  (t) => {
    const root = temporary(t);
    const stage = join(root, "stage");
    const app = join(root, "app");
    runtime(stage);
    cpSync(stage, app, { recursive: true });
    compilerRuntime(app);
    rmSync(join(app, "usr/lib/WebKitGPUProcess"));
    assert.throws(
      () => verifyWebkitGtk(app),
      /Missing WebKitGTK runtime file: WebKitGPUProcess/,
    );
    assert.throws(
      () => verifyWebkitGtk(app, stage),
      /Missing WebKitGTK runtime file: WebKitGPUProcess/,
    );
  },
);

test("requires the compiler runtime in the portable AppImage", linux, (t) => {
  const root = temporary(t);
  const stage = join(root, "stage");
  const app = join(root, "app");
  runtime(stage);
  cpSync(stage, app, { recursive: true });
  assert.throws(
    () => verifyWebkitGtk(app, stage),
    /Missing WebKitGTK runtime file: libstdc\+\+\.so\.6/,
  );
  compilerRuntime(app);
  assert.match(verifyWebkitGtk(app, stage), new RegExp(versionPattern));
  rmSync(join(app, "usr/lib/libgcc_s.so.1"));
  assert.throws(
    () => verifyWebkitGtk(app, stage),
    /Missing WebKitGTK runtime file: libgcc_s\.so\.1/,
  );
});

test(
  "the builder rejects a modified source archive before configuring or compiling it",
  linux,
  (t) => {
    const root = temporary(t);
    writeFileSync(
      join(root, `webkitgtk-${pinnedVersion}.tar.xz`),
      "modified source archive",
    );
    const result = spawnSync("bash", ["tooling/build-webkitgtk.sh"], {
      encoding: "utf8",
      env: {
        ...process.env,
        WEBKIT_BUILD_DIR: root,
        WEBKIT_STAGE_DIR: join(root, "stage"),
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stdout + result.stderr,
      /FAILED|checksum did NOT match/,
    );
  },
);
