const TAURI_ASSET_URL = /^asset:\/\/localhost(?:\/|$)/i;

export function isTauriAssetUrl(value: string): boolean {
  return TAURI_ASSET_URL.test(value);
}

export function shouldForceKeepMediaSrc(
  value: string,
  tauri: boolean,
): boolean {
  return value.startsWith("blob:") || (tauri && isTauriAssetUrl(value));
}
