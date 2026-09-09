import type { ISqlStorage } from "../sql/ISqlStorage";
import type { NodeApiClient } from "./nodeApiClient";
import type { StorageProfile } from "./storageProfile";

export interface AssetStorageRuntime {
  setItem(key: string, value: Uint8Array): Promise<unknown>;
  getItem(key: string, options?: { thumbnail?: boolean }): Promise<Uint8Array>;
  keys(prefix?: string): Promise<string[]>;
  removeItem(key: string | string[]): Promise<unknown>;
}

export class ActiveStorageRuntime {
  readonly profile: StorageProfile;
  readonly sql: ISqlStorage;
  readonly assets: AssetStorageRuntime;
  readonly nodeApiClient: NodeApiClient | null;

  constructor(options: {
    profile: StorageProfile;
    sql: ISqlStorage;
    assets: AssetStorageRuntime;
    nodeApiClient?: NodeApiClient | null;
  }) {
    const client = options.nodeApiClient ?? null;
    if (options.profile.mode === "remote" && !client) {
      throw new TypeError("Remote storage requires a Node API client.");
    }
    if (options.profile.mode === "local" && client) {
      throw new TypeError("Local storage cannot own a Node API client.");
    }
    this.profile = options.profile;
    this.sql = options.sql;
    this.assets = options.assets;
    this.nodeApiClient = client;
  }

  get isRemote(): boolean {
    return this.profile.mode === "remote";
  }
}

let activeRuntime: ActiveStorageRuntime | null = null;

export function installActiveStorageRuntime(runtime: ActiveStorageRuntime): void {
  if (activeRuntime && activeRuntime !== runtime) {
    throw new Error(
      "The active storage runtime is already installed. Reload before switching storage profiles.",
    );
  }
  activeRuntime = runtime;
}

export function getActiveStorageRuntime(): ActiveStorageRuntime {
  if (!activeRuntime) {
    throw new Error("The active storage runtime has not been initialized.");
  }
  return activeRuntime;
}

export function resetActiveStorageRuntimeForTesting(): void {
  activeRuntime = null;
}
