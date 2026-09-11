import {
  BaseDirectory,
  exists,
  readDir,
  readFile,
  remove,
  writeFile,
  open,
  stat,
  SeekMode,
} from "@tauri-apps/plugin-fs";

export class TauriAssetStorage {
  async hasStoredData(): Promise<boolean> {
    if (await exists("assets", { baseDir: BaseDirectory.AppData })) {
      const entries = await readDir("assets", {
        baseDir: BaseDirectory.AppData,
      });
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
    const entries = await readDir(directory, {
      baseDir: BaseDirectory.AppData,
    });
    return entries.map((entry) => `${directory}/${entry.name}`);
  }

  async listSyncAssetKeys(prefix = "assets/"): Promise<string[]> {
    const root = prefix.replace(/\/$/, "");
    if (!root || !(await exists(root, { baseDir: BaseDirectory.AppData }))) {
      return [];
    }
    const keys: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readDir(directory, {
        baseDir: BaseDirectory.AppData,
      })) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory) await visit(path);
        else if (entry.isFile !== false) keys.push(path);
      }
    };
    await visit(root);
    return keys.sort();
  }

  async getSyncAssetSize(key: string): Promise<number> {
    const info = await stat(key, { baseDir: BaseDirectory.AppData });
    return info.size;
  }

  async readSyncAssetChunk(
    key: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    const file = await open(key, {
      read: true,
      baseDir: BaseDirectory.AppData,
    });
    try {
      if (offset > 0) await file.seek(offset, SeekMode.Start);
      const buffer = new Uint8Array(length);
      let read = 0;
      while (read < length) {
        const count = await file.read(buffer.subarray(read));
        if (count === null || count === 0) break;
        read += count;
      }
      return read === buffer.length ? buffer : buffer.slice(0, read);
    } finally {
      await file.close();
    }
  }

  async removeItem(key: string | string[]): Promise<void> {
    for (const item of Array.isArray(key) ? key : [key]) {
      if (await exists(item, { baseDir: BaseDirectory.AppData })) {
        await remove(item, { baseDir: BaseDirectory.AppData });
      }
    }
  }
}
