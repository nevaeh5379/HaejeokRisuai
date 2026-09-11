import type { ISqlStorage } from "../sql/ISqlStorage";
import type { AutoStorage } from "../files/autoStorage";
import type { NodeApiClient } from "@risuai/storage-remote/nodeApiClient";
import type { StorageProfile } from "./storageProfile";

export class ActiveStorageRuntime {
  readonly profile: StorageProfile;
  readonly sql: ISqlStorage;
  readonly assets: AutoStorage;
  readonly nodeApiClient: NodeApiClient | null;

  constructor(options: {
    profile: StorageProfile;
    sql: ISqlStorage;
    assets: AutoStorage;
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
