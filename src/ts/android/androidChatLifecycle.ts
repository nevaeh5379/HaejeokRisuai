import { Capacitor, registerPlugin } from "@capacitor/core";

interface NativeChatPlugin {
  begin(): Promise<void>;
  end(): Promise<void>;
  complete(options: {
    title?: string;
    body?: string;
    notify: boolean;
    characterId?: string;
    chatId?: string;
  }): Promise<void>;
  showNotification(options: {
    title?: string;
    body?: string;
    characterId?: string;
    chatId?: string;
  }): Promise<void>;
  requestNotificationPermission(): Promise<{ granted: boolean }>;
}

const isAndroidNative =
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
const nativeChat = isAndroidNative
  ? registerPlugin<NativeChatPlugin>("NativeChat")
  : null;

/**
 * Bounds a native bridge call so a plugin promise that never settles cannot
 * hang chat finalization. Every helper below already swallows rejections, but
 * a hung bridge call never rejects — it just never resolves, which used to
 * leave the chat generation lock held forever (reroll/save/exit all blocked
 * until app restart). 응답하지 않는 브릿지 호출이 채팅 마무리를 영구히
 * 멈추지 않도록 대기 시간을 제한합니다.
 */
export async function boundedNativeCall<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch (error) {
    console.warn("[NativeChat] Bridge call failed:", error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const NATIVE_BRIDGE_TIMEOUT_MS = 5000;

export function usesNativeChatLifecycle(): boolean {
  return nativeChat !== null;
}

export async function beginNativeChatRequest(): Promise<void> {
  if (!nativeChat) return;
  try {
    await boundedNativeCall(nativeChat.begin(), NATIVE_BRIDGE_TIMEOUT_MS);
  } catch (error) {
    // Generation must still work if a vendor ROM refuses foreground service startup.
    console.warn("[NativeChat] Failed to start foreground generation:", error);
  }
}

export async function endNativeChatRequest(): Promise<void> {
  if (!nativeChat) return;
  try {
    await boundedNativeCall(nativeChat.end(), NATIVE_BRIDGE_TIMEOUT_MS);
  } catch (error) {
    console.warn("[NativeChat] Failed to stop foreground generation:", error);
  }
}

export async function completeNativeChatRequest(options: {
  title?: string;
  body?: string;
  notify: boolean;
  characterId?: string;
  chatId?: string;
}): Promise<void> {
  if (!nativeChat) return;
  try {
    await boundedNativeCall(
      nativeChat.complete(options),
      NATIVE_BRIDGE_TIMEOUT_MS,
    );
  } catch (error) {
    console.warn("[NativeChat] Failed to show completion notification:", error);
  }
}

export async function showNativeChatNotification(options: {
  title?: string;
  body?: string;
  characterId?: string;
  chatId?: string;
}): Promise<void> {
  if (!nativeChat) return;
  try {
    await boundedNativeCall(
      nativeChat.showNotification(options),
      NATIVE_BRIDGE_TIMEOUT_MS,
    );
  } catch (error) {
    console.warn("[NativeChat] Failed to show notification:", error);
  }
}

export async function requestNativeChatNotificationPermission(): Promise<boolean> {
  if (!nativeChat) return false;
  try {
    const result = await boundedNativeCall(
      nativeChat.requestNotificationPermission(),
      NATIVE_BRIDGE_TIMEOUT_MS,
    );
    return result?.granted ?? false;
  } catch (error) {
    console.warn(
      "[NativeChat] Failed to request notification permission:",
      error,
    );
    return false;
  }
}
