import { execFileSync } from "node:child_process";

export const LEGAL_CONFIG_GIT_KEY = "risu.legalConfigured";

type EnvMap = Record<string, string | undefined>;

export interface LegalConfigOptions {
  cwd?: string;
  env?: EnvMap;
  viteEnv?: EnvMap;
}

function isTrue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().toUpperCase() === "TRUE";
}

export function readGitLegalConfigured(
  cwd: string = process.cwd(),
): boolean | undefined {
  try {
    const value = execFileSync(
      "git",
      ["config", "--local", "--get", LEGAL_CONFIG_GIT_KEY],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    )
      .trim()
      .toLowerCase();

    if (value === "true") return true;
    if (value === "false") return false;
    return undefined;
  } catch {
    return undefined;
  }
}

export function resolveLegalConfigured({
  cwd = process.cwd(),
  env = process.env,
  viteEnv = {},
}: LegalConfigOptions = {}): boolean {
  const explicit =
    env.VITE_RISU_LEGAL_CONFIGURED ?? viteEnv.VITE_RISU_LEGAL_CONFIGURED;

  if (explicit !== undefined) return isTrue(explicit);
  return readGitLegalConfigured(cwd) === true;
}