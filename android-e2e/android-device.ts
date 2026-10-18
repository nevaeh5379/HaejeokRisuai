import { execFileSync } from "node:child_process";

export const ANDROID_E2E_APP_PACKAGE = "co.aiclient.risu";
export const ANDROID_E2E_APP_ACTIVITY = ".MainActivity";

function getScopedAdbArgs(args: string[]): string[] {
  return process.env.ANDROID_E2E_UDID
    ? ["-s", process.env.ANDROID_E2E_UDID, ...args]
    : args;
}

function runAdb(args: string[]): void {
  execFileSync("adb", getScopedAdbArgs(args), { stdio: "inherit" });
}

export function resetAndroidE2eAppData(): void {
  runAdb(["shell", "am", "force-stop", ANDROID_E2E_APP_PACKAGE]);
  runAdb(["shell", "pm", "clear", ANDROID_E2E_APP_PACKAGE]);
}
