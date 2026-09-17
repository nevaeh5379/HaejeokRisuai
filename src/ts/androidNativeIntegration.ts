import { Capacitor, registerPlugin } from "@capacitor/core";

export type AndroidNativeEntry = {
  type:
    | "share-text"
    | "process-text"
    | "open-chat"
    | "open-character"
    | "new-chat";
  text?: string;
  subject?: string;
  mimeType?: string;
  characterId?: string;
  chatId?: string;
};

interface NativeIntegrationPlugin {
  consumePendingEntries(): Promise<{ entries: AndroidNativeEntry[] }>;
}

const isAndroidNative =
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
const nativeIntegration = isAndroidNative
  ? registerPlugin<NativeIntegrationPlugin>("NativeIntegration")
  : null;

export function usesAndroidNativeIntegration(): boolean {
  return nativeIntegration !== null;
}
export function installAndroidNativeEntryHandler(
  handler: (entry: AndroidNativeEntry) => void | Promise<void>,
): () => void {
  if (!nativeIntegration || typeof window === "undefined") return () => {};

  let disposed = false;
  let draining: Promise<void> | null = null;

  const drain = () => {
    if (draining) return draining;
    draining = (async () => {
      try {
        do {
          const result = await nativeIntegration.consumePendingEntries();
          if (disposed || result.entries.length === 0) break;
          for (const entry of result.entries) {
            if (disposed) break;
            await handler(entry);
          }
        } while (!disposed);
      } catch (error) {
        console.warn("[NativeIntegration] Failed to consume Android entry:", error);
      } finally {
        draining = null;
      }
    })();
    return draining;
  };

  const onAvailable = () => void drain();
  window.addEventListener("risu:native-entry-available", onAvailable);
  void drain();

  return () => {
    disposed = true;
    window.removeEventListener("risu:native-entry-available", onAvailable);
  };
}
