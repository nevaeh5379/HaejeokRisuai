import { execFileSync } from "node:child_process";

export const LEGAL_CONFIG_GIT_KEY = "risu.legalConfigured";

function isTrue(value) {
  return typeof value === "string" && value.trim().toUpperCase() === "TRUE";
}

export function readGitLegalConfigured(cwd = process.cwd()) {
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
} = {}) {
  const explicit =
    env.VITE_RISU_LEGAL_CONFIGURED ?? viteEnv.VITE_RISU_LEGAL_CONFIGURED;

  if (explicit !== undefined) return isTrue(explicit);
  return readGitLegalConfigured(cwd) === true;
}
