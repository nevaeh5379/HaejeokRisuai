import localforage from "localforage";
import { isCapacitor, isNodeServer } from "src/ts/platform";
import type { CapacitorStorage } from "./capacitorStorage";
import { NodeStorage } from "./nodeStorage";
import { OpfsStorage } from "./opfsStorage";

export class AutoStorage {
  /** @deprecated Haejeok RisuAI does not support Risu Account storage. */
  readonly isAccount = false;

  realStorage: LocalForage | NodeStorage | OpfsStorage | CapacitorStorage;

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

  async Init() {
    if (this.realStorage) return;

    // Remove legacy account-sync markers. Haejeok RisuAI intentionally does
    // not integrate with Risu Account storage.
    localStorage.removeItem("accountst");
    localStorage.removeItem("dosync");
    localStorage.removeItem("fallbackRisuToken");

    if (isNodeServer) {
      console.log("using node storage");
      this.realStorage = new NodeStorage();
      return;
    }

    if (isCapacitor) {
      console.log("using Capacitor native filesystem storage");
      const { CapacitorStorage } = await import("./capacitorStorage");
      this.realStorage = new CapacitorStorage();
      return;
    }

    console.log("using forage storage");
    this.realStorage = localforage.createInstance({
      name: "risuai",
    });
  }

  listItem = this.keys;
}
