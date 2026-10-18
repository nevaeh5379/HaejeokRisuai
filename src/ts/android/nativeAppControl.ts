import { registerPlugin } from "@capacitor/core";

interface NativeAppControl {
  exitApp(): Promise<void>;
  getSafeMode(): Promise<{ enabled: boolean }>;
}

export const nativeAppControl =
  registerPlugin<NativeAppControl>("NativeAppControl");
