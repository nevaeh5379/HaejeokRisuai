import {
  BaseDirectory,
  exists,
  readDir,
  readFile,
  remove,
  writeFile,
} from "@tauri-apps/plugin-fs";

export class TauriAssetStorage {
  async hasStoredData(): Promise<boolean> {
    if (await exists("assets", { baseDir: BaseDirectory.AppData })) {
      const entries = await readDir("assets", { baseDir: BaseDirectory.AppData });
      if (entries.length > 0) return true;
    }

    for (const path of [
      "database/database.bin",
      "save/database/database.bin",
      "save/database.bin",
    ]) {
      if (await exists(path, { baseDir: BaseDirectory.AppData })) return true;
    }
    return false;
  }

  async setItem(key: string, value: Uint8Array): Promise<void> {
    await writeFile(key, value, { baseDir: BaseDirectory.AppData });
  }

  async getItem(key: string): Promise<Uint8Array> {
    return await readFile(key, { baseDir: BaseDirectory.AppData });
  }

  async keys(prefix = ""): Promise<string[]> {
    const directory = prefix.replace(/\/$/, "");
    if (
      !directory ||
      !(await exists(directory, { baseDir: BaseDirectory.AppData }))
    ) {
      return [];
    }
    const entries = await readDir(directory, { baseDir: BaseDirectory.AppData });
    return entries.map((entry) => `${directory}/${entry.name}`);
  }

  async removeItem(key: string | string[]): Promise<void> {
    for (const item of Array.isArray(key) ? key : [key]) {
      if (await exists(item, { baseDir: BaseDirectory.AppData })) {
        await remove(item, { baseDir: BaseDirectory.AppData });
      }
    }
  }
}
