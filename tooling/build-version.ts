import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export type BuildVersionSource = "fallback" | "git" | "environment";

export interface BuildVersionResult {
  buildNumber: number | null;
  buildTag: string;
  tauriVersion: string;
  source: BuildVersionSource;
}

export interface ResolveBuildVersionOptions {
  cwd?: string;
  env?: Record<string, string | undefined> | NodeJS.ProcessEnv;
}

function parseBuildNumber(value: unknown, source: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${source} must be a non-negative integer, got: ${value}`);
  }
  return Number.parseInt(normalized, 10);
}

function readGitBuildNumber(cwd: string): number | null {
  try {
    const output = execFileSync("git", ["rev-list", "--count", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return parseBuildNumber(output, "git rev-list --count HEAD");
  } catch {
    return null;
  }
}

export function resolveBuildVersion({
  cwd = defaultRepoRoot,
  env = process.env,
}: ResolveBuildVersionOptions = {}): BuildVersionResult {
  const explicitBuildNumber = parseBuildNumber(
    env.HAEJEOK_BUILD_NUMBER,
    "HAEJEOK_BUILD_NUMBER",
  );
  const buildNumber = explicitBuildNumber ?? readGitBuildNumber(cwd);

  if (buildNumber === null) {
    return {
      buildNumber: null,
      buildTag: "bunknown",
      tauriVersion: "0.0.0",
      source: "fallback",
    };
  }

  return {
    buildNumber,
    buildTag: `b${buildNumber}`,
    tauriVersion: `0.0.${buildNumber}`,
    source: explicitBuildNumber === null ? "git" : "environment",
  };
}

export { defaultRepoRoot };
