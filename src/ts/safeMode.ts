import { isCapacitorAndroid, isTauri } from "./platform";
import { nativeAppControl } from "./android/nativeAppControl";

let launchMode: Promise<boolean> | undefined;

export function isSafeModeEnabled(): Promise<boolean> {
  return (launchMode ??= resolveSafeMode());
}

async function resolveSafeMode(): Promise<boolean> {
  if (new URLSearchParams(globalThis.location?.search).get("safe") === "1")
    return true;
  if (
    (globalThis as typeof globalThis & { __HAEJEOK_SAFE_MODE__?: boolean })
      .__HAEJEOK_SAFE_MODE__ === true
  )
    return true;
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<boolean>("get_safe_mode");
  }
  if (isCapacitorAndroid) return (await nativeAppControl.getSafeMode()).enabled;
  return false;
}
