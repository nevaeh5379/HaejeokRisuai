import { registerPlugin } from "@capacitor/core";
import { isCapacitorAndroid } from "../platform";

interface CrashDiagnosticsPlugin {
  checkpoint(options: { stage: string }): Promise<void>;
  shareDiagnostics(): Promise<void>;
}

const native = isCapacitorAndroid
  ? registerPlugin<CrashDiagnosticsPlugin>("CrashGuard")
  : null;

/** Await before risky startup work so its checkpoint survives a dead renderer. */
export async function androidDiagnosticCheckpoint(
  stage: string,
): Promise<void> {
  if (!native) return;
  try {
    await native.checkpoint({ stage });
  } catch {
    // Diagnostics must not block startup on an older native app shell.
  }
}

export function initializeAndroidDiagnostics(): void {
  if (!native) return;
  // Record categories only. Error/rejection messages can contain user content.
  window.addEventListener("error", () => {
    void androidDiagnosticCheckpoint("js:uncaught-error");
  });
  window.addEventListener("unhandledrejection", () => {
    void androidDiagnosticCheckpoint("js:unhandled-rejection");
  });
}

export async function shareAndroidDiagnostics(): Promise<void> {
  await native?.shareDiagnostics();
}
