import type { StorageSyncDirection } from "./nodeApiClient";

const STORAGE_SYNC_RESUME_KEY = "risuai.storageSync.resume.v1";

export interface StorageSyncResumeState {
  version: 1;
  serverOrigin: string;
  sessionId: string;
  direction: StorageSyncDirection;
  sourceRevision: number;
  createdAt: number;
}

export type StorageSyncResumeStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

function defaultStorage(): StorageSyncResumeStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadStorageSyncResumeState(
  storage: StorageSyncResumeStorage | null = defaultStorage(),
): StorageSyncResumeState | null {
  if (!storage) return null;
  try {
    const value = JSON.parse(
      storage.getItem(STORAGE_SYNC_RESUME_KEY) ?? "null",
    );
    if (
      value?.version !== 1 ||
      typeof value.serverOrigin !== "string" ||
      typeof value.sessionId !== "string" ||
      (value.direction !== "local-to-remote" &&
        value.direction !== "remote-to-local") ||
      !Number.isSafeInteger(value.sourceRevision) ||
      !Number.isFinite(value.createdAt)
    ) {
      return null;
    }
    return value as StorageSyncResumeState;
  } catch {
    return null;
  }
}

export function saveStorageSyncResumeState(
  state: StorageSyncResumeState,
  storage: StorageSyncResumeStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  storage.setItem(STORAGE_SYNC_RESUME_KEY, JSON.stringify(state));
}

export function clearStorageSyncResumeState(
  sessionId?: string,
  storage: StorageSyncResumeStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  if (
    !sessionId ||
    loadStorageSyncResumeState(storage)?.sessionId === sessionId
  ) {
    storage.removeItem(STORAGE_SYNC_RESUME_KEY);
  }
}
