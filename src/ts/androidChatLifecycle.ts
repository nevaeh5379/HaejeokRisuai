import { Capacitor, registerPlugin } from "@capacitor/core";

interface NativeChatPlugin {
  begin(): Promise<void>;
  end(): Promise<void>;
  complete(options: {
    title?: string;
    body?: string;
    notify: boolean;
  }): Promise<void>;
  showNotification(options: { title?: string; body?: string }): Promise<void>;
  requestNotificationPermission(): Promise<{ granted: boolean }>;
}

const isAndroidNative =
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
const nativeChat = isAndroidNative
  ? registerPlugin<NativeChatPlugin>("NativeChat")
  : null;

export function usesNativeChatLifecycle(): boolean {
  return nativeChat !== null;
}

export async function beginNativeChatRequest(): Promise<void> {
  if (!nativeChat) return;
  try {
    await nativeChat.begin();
  } catch (error) {
    // Generation must still work if a vendor ROM refuses foreground service startup.
    console.warn("[NativeChat] Failed to start foreground generation:", error);
  }
}

export async function endNativeChatRequest(): Promise<void> {
  if (!nativeChat) return;
  try {
    await nativeChat.end();
  } catch (error) {
    console.warn("[NativeChat] Failed to stop foreground generation:", error);
  }
}

export async function completeNativeChatRequest(options: {
  title?: string;
  body?: string;
  notify: boolean;
}): Promise<void> {
  if (!nativeChat) return;
  try {
    await nativeChat.complete(options);
  } catch (error) {
    console.warn("[NativeChat] Failed to show completion notification:", error);
  }
}

export async function showNativeChatNotification(options: {
  title?: string;
  body?: string;
}): Promise<void> {
  if (!nativeChat) return;
  try {
    await nativeChat.showNotification(options);
  } catch (error) {
    console.warn("[NativeChat] Failed to show notification:", error);
  }
}

export async function requestNativeChatNotificationPermission(): Promise<boolean> {
  if (!nativeChat) return false;
  try {
    return (await nativeChat.requestNotificationPermission()).granted;
  } catch (error) {
    console.warn(
      "[NativeChat] Failed to request notification permission:",
      error,
    );
    return false;
  }
}
