import { describe, expect, it } from "vitest";
import {
  clearStorageSyncResumeState,
  loadStorageSyncResumeState,
  saveStorageSyncResumeState,
} from "./storageSyncResumeState";

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

const state = {
  version: 1 as const,
  serverOrigin: "https://sync.example.com",
  sessionId: "session-1",
  direction: "local-to-remote" as const,
  sourceRevision: 42,
  createdAt: 1234,
};
describe("storage sync resume state", () => {
  it("round-trips only compact session identity metadata", () => {
    const storage = new MemoryStorage();
    saveStorageSyncResumeState(state, storage);
    expect(loadStorageSyncResumeState(storage)).toEqual(state);
    expect([...storage.values.values()][0]).not.toContain("offset");
  });

  it("ignores corrupt or incomplete persisted state", () => {
    const storage = new MemoryStorage();
    storage.setItem("risuai.storageSync.resume.v1", "{broken");
    expect(loadStorageSyncResumeState(storage)).toBeNull();
    storage.setItem(
      "risuai.storageSync.resume.v1",
      JSON.stringify({ ...state, sourceRevision: -1.5 }),
    );
    expect(loadStorageSyncResumeState(storage)).toBeNull();
  });

  it("clears only the matching session when an id is supplied", () => {
    const storage = new MemoryStorage();
    saveStorageSyncResumeState(state, storage);
    clearStorageSyncResumeState("other-session", storage);
    expect(loadStorageSyncResumeState(storage)).toEqual(state);
    clearStorageSyncResumeState("session-1", storage);
    expect(loadStorageSyncResumeState(storage)).toBeNull();
  });
});
