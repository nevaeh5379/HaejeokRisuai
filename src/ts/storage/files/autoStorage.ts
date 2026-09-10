import localforage from "localforage";
import { isCapacitor, isNodeServer, isTauri } from "src/ts/platform";
import type { CapacitorStorage } from "./capacitorStorage";
import { NodeStorage } from "./nodeStorage";
import { OpfsStorage } from "./opfsStorage";
import { TauriAssetStorage } from "./tauriAssetStorage";
import type { NodeApiClient } from "../runtime/nodeApiClient";
import type { StorageProfile } from "../runtime/storageProfile";
import {
  createStorageSyncAssetReader,
  type StorageSyncAssetReader,
} from "../runtime/storageSyncAssetReader";

export class AutoStorage {
  /** @deprecated Haejeok RisuAI does not support Risu Account storage. */
  readonly isAccount = false;

  realStorage:
    | LocalForage
    | NodeStorage
    | OpfsStorage
    | CapacitorStorage
    | TauriAssetStorage;
  private profile: StorageProfile | null = null;

  async setItem(key: string, value: Uint8Array): Promise<string | null> {
    await this.Init();
    await this.realStorage.setItem(key, value);
    return null;
  }

  async getItem(
    key: string,
    options?: { thumbnail?: boolean },
  ): Promise<Buffer> {
    await this.Init();
    return await (this.realStorage as any).getItem(key, options);
  }

  async keys(): Promise<string[]> {
    await this.Init();
    return await this.realStorage.keys();
  }

  async removeItem(key: string | string[]) {
    await this.Init();
    return await (this.realStorage as any).removeItem(key);
  }

  async getStorageSyncAssetReader(): Promise<StorageSyncAssetReader> {
    await this.Init();
    return createStorageSyncAssetReader(this.realStorage);
  }

  async listAssetKeys(prefix = "assets/"): Promise<string[]> {
    const reader = await this.getStorageSyncAssetReader();
    return await reader.listKeys(prefix);
  }

  async hasStoredData(): Promise<boolean> {
    await this.Init();
    if (this.realStorage instanceof TauriAssetStorage) {
      return await this.realStorage.hasStoredData();
    }
    const storage = this.realStorage as LocalForage & {
      length?: () => Promise<number>;
    };
    if (typeof storage.length === "function") {
      return (await storage.length()) > 0;
    }
    return (await this.realStorage.keys()).length > 0;
  }

  async Init(options?: {
    profile?: StorageProfile;
    nodeApiClient?: NodeApiClient | null;
  }) {
    if (this.realStorage) {
      if (options?.profile && this.profile?.mode !== options.profile.mode) {
        throw new Error(
          "Asset storage was already initialized for a different profile. Reload before switching storage.",
        );
      }
      return;
    }
    const profile =
      options?.profile ??
      ({
        version: 1,
        mode: isNodeServer ? "remote" : "local",
      } as StorageProfile);
    this.profile = profile;

    // Remove legacy account-sync markers. Haejeok RisuAI intentionally does
    // not integrate with Risu Account storage.
    localStorage.removeItem("accountst");
    localStorage.removeItem("dosync");
    localStorage.removeItem("fallbackRisuToken");

    if (profile.mode === "remote") {
      if (!options?.nodeApiClient) {
        throw new Error("Remote asset storage requires a Node API client.");
      }
      console.log("using node storage");
      this.realStorage = new NodeStorage(options.nodeApiClient);
      return;
    }

    if (isCapacitor) {
      console.log("using Capacitor native filesystem storage");
      const { CapacitorStorage } = await import("./capacitorStorage");
      this.realStorage = new CapacitorStorage();
      return;
    }

    if (isTauri) {
      console.log("using Tauri native filesystem storage");
      this.realStorage = new TauriAssetStorage();
      return;
    }

    console.log("using forage storage");
    this.realStorage = localforage.createInstance({
      name: "risuai",
    });
  }

  listItem = this.keys;
}
