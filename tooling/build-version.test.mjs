import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { defaultRepoRoot, resolveBuildVersion } from "./build-version.mjs";

describe("resolveBuildVersion", () => {
  it("uses the HAEJEOK_BUILD_NUMBER override when provided", () => {
    expect(
      resolveBuildVersion({
        cwd: "/tmp",
        env: { HAEJEOK_BUILD_NUMBER: "7777" },
      }),
    ).toEqual({
      buildNumber: 7777,
      buildTag: "b7777",
      tauriVersion: "0.0.7777",
      source: "environment",
    });
  });

  it("derives the local build number from the Git commit count", () => {
    const count = Number.parseInt(
      execFileSync("git", ["rev-list", "--count", "HEAD"], {
        cwd: defaultRepoRoot,
        encoding: "utf8",
      }).trim(),
      10,
    );
    expect(resolveBuildVersion().buildTag).toBe(`b${count}`);
  });

  it("falls back safely when Git metadata is unavailable", () => {
    expect(resolveBuildVersion({ cwd: "/tmp", env: {} })).toEqual({
      buildNumber: null,
      buildTag: "bunknown",
      tauriVersion: "0.0.0",
      source: "fallback",
    });
  });

  it("rejects invalid explicit build numbers", () => {
    expect(() =>
      resolveBuildVersion({
        env: { HAEJEOK_BUILD_NUMBER: "not-a-number" },
      }),
    ).toThrow(/HAEJEOK_BUILD_NUMBER/);
  });
});
