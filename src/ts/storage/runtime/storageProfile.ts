export const STORAGE_PROFILE_KEY = "risu-storage-profile-v1";

export type StorageProfile =
  | { version: 1; mode: "local" }
  | {
      version: 1;
      mode: "remote";
      baseUrl: string;
      allowInsecureHttp: boolean;
    };

export type StorageProfilePlatform = "web" | "tauri" | "capacitor" | "node";

export interface StorageProfileStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class StorageProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageProfileError";
  }
}

function assertRemoteUrlIsAllowed(
  url: URL,
  allowInsecureHttp: boolean,
  platform: StorageProfilePlatform,
  pageProtocol?: string,
): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new StorageProfileError("The storage server must use HTTPS or HTTP.");
  }
  if (url.username || url.password) {
    throw new StorageProfileError(
      "The storage server URL must not contain credentials.",
    );
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new StorageProfileError(
      "The storage server URL must contain only an origin, without a path, query, or fragment.",
    );
  }
  if (url.protocol === "http:" && !allowInsecureHttp) {
    throw new StorageProfileError(
      "HTTP storage servers require explicit insecure HTTP approval.",
    );
  }
  if (
    platform === "web" &&
    pageProtocol === "https:" &&
    url.protocol === "http:"
  ) {
    throw new StorageProfileError(
      "An HTTPS web app cannot connect to an HTTP storage server because browsers block mixed content.",
    );
  }
}

export function normalizeRemoteBaseUrl(
  input: string,
  options: {
    allowInsecureHttp: boolean;
    platform: StorageProfilePlatform;
    pageProtocol?: string;
  },
): string {
  const value = input.trim();
  if (!value) {
    throw new StorageProfileError("Enter a storage server URL.");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StorageProfileError("The storage server URL is invalid.");
  }
  assertRemoteUrlIsAllowed(
    url,
    options.allowInsecureHttp,
    options.platform,
    options.pageProtocol,
  );
  return url.origin;
}

export function parseStorageProfile(value: unknown): StorageProfile | null {
  if (!value || typeof value !== "object") return null;
  const profile = value as Record<string, unknown>;
  if (profile.version !== 1) return null;
  if (profile.mode === "local") {
    return { version: 1, mode: "local" };
  }
  if (
    profile.mode !== "remote" ||
    typeof profile.baseUrl !== "string" ||
    typeof profile.allowInsecureHttp !== "boolean"
  ) {
    return null;
  }
  try {
    return {
      version: 1,
      mode: "remote",
      baseUrl: normalizeRemoteBaseUrl(profile.baseUrl, {
        allowInsecureHttp: profile.allowInsecureHttp,
        platform: "node",
      }),
      allowInsecureHttp: profile.allowInsecureHttp,
    };
  } catch {
    return null;
  }
}

export function loadStorageProfile(
  store: StorageProfileStore = localStorage,
): StorageProfile | null {
  const encoded = store.getItem(STORAGE_PROFILE_KEY);
  if (!encoded) return null;
  try {
    return parseStorageProfile(JSON.parse(encoded));
  } catch {
    return null;
  }
}

export function saveStorageProfile(
  profile: StorageProfile,
  store: StorageProfileStore = localStorage,
): void {
  const parsed = parseStorageProfile(profile);
  if (!parsed) {
    throw new StorageProfileError("Cannot save an invalid storage profile.");
  }
  store.setItem(STORAGE_PROFILE_KEY, JSON.stringify(parsed));
}

export function clearStorageProfile(
  store: StorageProfileStore = localStorage,
): void {
  store.removeItem(STORAGE_PROFILE_KEY);
}
