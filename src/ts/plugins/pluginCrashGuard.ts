import { registerPlugin } from "@capacitor/core";
import { isCapacitorAndroid } from "../platform";

interface CrashGuardNative {
  setLoadingPlugin(options: { name: string }): Promise<void>;
  clearLoadingPlugin(): Promise<void>;
  getBlockedPlugins(): Promise<{ plugins: string[] }>;
  clearBlockedPlugin(options: { name: string }): Promise<void>;
}

const isAndroidNative = isCapacitorAndroid;

// Lazily created: keeps the module cheap to import on web/Tauri/Node where
// the crash guard is a no-op.
let crashGuardInstance: CrashGuardNative | null = null;
function getCrashGuard(): CrashGuardNative | null {
  if (!isAndroidNative) return null;
  if (!crashGuardInstance) {
    crashGuardInstance = registerPlugin<CrashGuardNative>("CrashGuard");
  }
  return crashGuardInstance;
}

/**
 * Native blocklist of plugins blamed for a renderer death mid-load.
 * Populated by the Android side when the WebView renderer dies while a
 * plugin sandbox is starting; consumed at the next boot to skip loading
 * the culprit and permanently disable it (see applyBlockedPlugins).
 */
export async function getBlockedPlugins(): Promise<string[]> {
  const guard = getCrashGuard();
  if (!guard) return [];
  try {
    return (await guard.getBlockedPlugins()).plugins ?? [];
  } catch (error) {
    console.error("CrashGuard: failed to read blocked plugins", error);
    return [];
  }
}

/** Records "about to load plugin X" so a renderer death blames X. */
export async function setLoadingPlugin(name: string): Promise<void> {
  const guard = getCrashGuard();
  if (!guard) return;
  try {
    await guard.setLoadingPlugin({ name });
  } catch (error) {
    console.error("CrashGuard: failed to set loading ledger", error);
  }
}

/** Clears the ledger once boot has stabilized. */
export async function clearLoadingPlugin(): Promise<void> {
  const guard = getCrashGuard();
  if (!guard) return;
  try {
    await guard.clearLoadingPlugin();
  } catch (error) {
    console.error("CrashGuard: failed to clear loading ledger", error);
  }
}

/** Removes one entry from the native blocklist (after the DB caught up). */
export async function clearBlockedPlugin(name: string): Promise<void> {
  const guard = getCrashGuard();
  if (!guard) return;
  try {
    await guard.clearBlockedPlugin({ name });
  } catch (error) {
    console.error("CrashGuard: failed to clear blocked plugin", error);
  }
}