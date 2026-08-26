import { Directory, Filesystem } from "@capacitor/filesystem";
import { Buffer } from "buffer";

const ROOT = "risuai-assets";
const FILE_SUFFIX = ".bin";

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  return Buffer.from(padded, "base64");
}

function keyToFilename(key: string): string {
  return `${encodeBase64Url(Buffer.from(key, "utf8"))}${FILE_SUFFIX}`;
}

function filenameToKey(filename: string): string | null {
  if (!filename.endsWith(FILE_SUFFIX)) return null;
  try {
    return decodeBase64Url(filename.slice(0, -FILE_SUFFIX.length)).toString(
      "utf8",
    );
  } catch {
    return null;
  }
}

/**
 * Native asset/key-value storage for the Capacitor Android build.
 * Files live in Android's app-private data directory instead of IndexedDB.
 */
export class CapacitorStorage {
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  private async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        try {
          await Filesystem.mkdir({
            path: ROOT,
            directory: Directory.Data,
            recursive: true,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/exist/i.test(message)) throw error;
        }
        this.initialized = true;
      })().finally(() => {
        this.initPromise = null;
      });
    }
    await this.initPromise;
  }

  async setItem(key: string, value: Uint8Array): Promise<void> {
    await this.init();
    await Filesystem.writeFile({
      path: `${ROOT}/${keyToFilename(key)}`,
      directory: Directory.Data,
      data: Buffer.from(value).toString("base64"),
      recursive: true,
    });
  }

  async getItem(key: string): Promise<Buffer | null> {
    await this.init();
    try {
      const result = await Filesystem.readFile({
        path: `${ROOT}/${keyToFilename(key)}`,
        directory: Directory.Data,
      });
      if (typeof result.data === "string") {
        return Buffer.from(result.data, "base64");
      }
      return Buffer.from(await result.data.arrayBuffer());
    } catch {
      return null;
    }
  }

  async keys(): Promise<string[]> {
    await this.init();
    const result = await Filesystem.readdir({
      path: ROOT,
      directory: Directory.Data,
    });
    return result.files
      .map((entry) => filenameToKey(entry.name))
      .filter((key): key is string => key !== null);
  }

  async removeItem(key: string | string[]): Promise<void> {
    await this.init();
    const keys = Array.isArray(key) ? key : [key];
    await Promise.all(
      keys.map(async (item) => {
        try {
          await Filesystem.deleteFile({
            path: `${ROOT}/${keyToFilename(item)}`,
            directory: Directory.Data,
          });
        } catch {
          // Match localForage semantics: deleting a missing key is harmless.
        }
      }),
    );
  }

  listItem = this.keys.bind(this);
}
