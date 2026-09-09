import { describe, expect, it } from "vitest";
import {
  loadStorageProfile,
  normalizeRemoteBaseUrl,
  saveStorageProfile,
  STORAGE_PROFILE_KEY,
  StorageProfileError,
  type StorageProfileStore,
} from "./storageProfile";

function memoryStore(): StorageProfileStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

describe("storage profile", () => {
  it("normalizes a remote server to its origin", () => {
    expect(
      normalizeRemoteBaseUrl("  https://example.com:8443/  ", {
        allowInsecureHttp: false,
        platform: "tauri",
      }),
    ).toBe("https://example.com:8443");
  });

  it("rejects credentials and non-origin URL parts", () => {
    expect(() =>
      normalizeRemoteBaseUrl("https://user:secret@example.com", {
        allowInsecureHttp: false,
        platform: "web",
      }),
    ).toThrow(StorageProfileError);
    expect(() =>
      normalizeRemoteBaseUrl("https://example.com/risu", {
        allowInsecureHttp: false,
        platform: "web",
      }),
    ).toThrow(/only an origin/);
  });

  it("requires explicit approval for HTTP", () => {
    expect(() =>
      normalizeRemoteBaseUrl("http://192.168.1.2:6001", {
        allowInsecureHttp: false,
        platform: "tauri",
      }),
    ).toThrow(/explicit insecure HTTP approval/);
    expect(
      normalizeRemoteBaseUrl("http://192.168.1.2:6001", {
        allowInsecureHttp: true,
        platform: "tauri",
      }),
    ).toBe("http://192.168.1.2:6001");
  });

  it("does not claim HTTP works from an HTTPS web page", () => {
    expect(() =>
      normalizeRemoteBaseUrl("http://example.com", {
        allowInsecureHttp: true,
        platform: "web",
        pageProtocol: "https:",
      }),
    ).toThrow(/mixed content/);
  });

  it("persists only the versioned profile fields", () => {
    const store = memoryStore();
    saveStorageProfile(
      {
        version: 1,
        mode: "remote",
        baseUrl: "https://example.com",
        allowInsecureHttp: false,
      },
      store,
    );
    expect(loadStorageProfile(store)).toEqual({
      version: 1,
      mode: "remote",
      baseUrl: "https://example.com",
      allowInsecureHttp: false,
    });
    expect(store.values.get(STORAGE_PROFILE_KEY)).not.toContain("password");
  });

  it("treats malformed and future profiles as missing", () => {
    const store = memoryStore();
    store.setItem(STORAGE_PROFILE_KEY, "not json");
    expect(loadStorageProfile(store)).toBeNull();
    store.setItem(
      STORAGE_PROFILE_KEY,
      JSON.stringify({ version: 2, mode: "local" }),
    );
    expect(loadStorageProfile(store)).toBeNull();
  });
});
