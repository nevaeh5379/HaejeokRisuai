// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const bootstrapPath = fileURLToPath(
  new URL("./bootstrap.cjs", import.meta.url),
);
const source = readFileSync(bootstrapPath, "utf8");
const serverRoot = path.dirname(bootstrapPath);

function runBootstrap(newerSource?: string, nodeEnv = "development") {
  const spawnSync = vi.fn(
    (_executable: string, _args: string[], _options: unknown) => ({
      status: 0,
    }),
  );
  const loadServer = vi.fn();
  runInNewContext(source, {
    __dirname: serverRoot,
    process: { env: { NODE_ENV: nodeEnv }, execPath: process.execPath },
    require: (module: string) => {
      if (module === "node:path") return path;
      if (module === "node:child_process") return { spawnSync };
      if (module === "node:fs") {
        return {
          existsSync: () => true,
          statSync: (file: string) => ({
            mtimeMs:
              file === newerSource
                ? 3
                : file.includes(`${path.sep}dist${path.sep}`)
                  ? 2
                  : 1,
          }),
        };
      }
      loadServer(module);
    },
  });
  return { spawnSync, loadServer };
}

describe("Node server bootstrap bundle freshness", () => {
  it.each(["postgresStorage.cjs", "postgresJsonCodec.cjs"])(
    "rebuilds an existing bundle when %s changes",
    (file) => {
      const { spawnSync, loadServer } = runBootstrap(
        path.join(serverRoot, "storage/postgres", file),
      );
      expect(spawnSync).toHaveBeenCalledOnce();
      expect(spawnSync.mock.calls[0][1]).toEqual([
        path.resolve(serverRoot, "../../tooling/build-node-server.mjs"),
      ]);
      expect(loadServer).toHaveBeenCalledWith(
        path.join(serverRoot, "dist/server.cjs"),
      );
    },
  );

  it("uses an up-to-date bundle without rebuilding", () => {
    expect(runBootstrap().spawnSync).not.toHaveBeenCalled();
  });

  it("keeps production's prebuilt bundle behavior", () => {
    expect(
      runBootstrap(
        path.join(serverRoot, "storage/postgres/postgresJsonCodec.cjs"),
        "production",
      ).spawnSync,
    ).not.toHaveBeenCalled();
  });
});
