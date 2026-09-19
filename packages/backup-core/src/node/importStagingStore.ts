import { once } from "node:events";
import { createWriteStream, promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import {
  BackupContainerParser,
  type BackupContainerEntryInfo,
} from "../containerStream";
import {
  classifyBackupEntry,
  type BackupEntryKind,
} from "../entryPolicy";

export interface StagedBackupEntry {
  index: number;
  name: string;
  size: number;
  kind: Exclude<BackupEntryKind, "invalid" | "extension" | "encryption">;
  filePath: string;
}

export interface StagedBackupContainer {
  entries: StagedBackupEntry[];
  bytesRead: number;
  ignoredExtensionEntries: number;
}

export class BackupImportStagingError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_job_id"
      | "invalid_entry"
      | "encrypted_backup_unsupported"
      | "staging_error" = "staging_error",
  ) {
    super(message);
    this.name = "BackupImportStagingError";
  }
}

interface ActiveEntry {
  info: BackupContainerEntryInfo;
  staged: StagedBackupEntry | null;
  writer: ReturnType<typeof createWriteStream> | null;
  done: Promise<void> | null;
}

export class BackupImportStagingStore {
  private readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
  }

  private jobDirectory(id: string): string {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
      throw new BackupImportStagingError(
        "Invalid local backup import job id",
        "invalid_job_id",
      );
    }
    return join(this.rootPath, id);
  }

  async stage(
    id: string,
    chunks: AsyncIterable<Uint8Array>,
    options: {
      totalBytes?: number;
      onProgress?: (progress: {
        bytesRead: number;
        totalBytes: number;
        entryName?: string;
      }) => void;
    } = {},
  ): Promise<StagedBackupContainer> {
    const directory = this.jobDirectory(id);
    await fs.rm(directory, { recursive: true, force: true });
    await fs.mkdir(directory, { recursive: true });

    const entries: StagedBackupEntry[] = [];
    let ignoredExtensionEntries = 0;
    let active: ActiveEntry | null = null;
    let bytesRead = 0;
    let entryIndex = 0;

    const closeActive = async (abort = false): Promise<void> => {
      const current = active;
      active = null;
      if (!current?.writer) return;
      if (abort) {
        current.writer.destroy();
        if (current.staged) {
          await fs.rm(current.staged.filePath, { force: true }).catch(() => {});
        }
        return;
      }
      current.writer.end();
      await current.done;
    };

    const parser = new BackupContainerParser({
      onEntryStart: async (info) => {
        const classification = classifyBackupEntry(info.name);
        if (classification.kind === "invalid" || !classification.normalized) {
          throw new BackupImportStagingError(
            `Invalid backup entry path: ${info.name}`,
            "invalid_entry",
          );
        }
        if (classification.kind === "encryption") {
          throw new BackupImportStagingError(
            "Account-encrypted backups are intentionally unsupported.",
            "encrypted_backup_unsupported",
          );
        }
        if (classification.kind === "extension") {
          ignoredExtensionEntries++;
          active = {
            info,
            staged: null,
            writer: null,
            done: null,
          };
          return;
        }

        const filePath = join(
          directory,
          `${String(entryIndex).padStart(8, "0")}.part`,
        );
        const staged: StagedBackupEntry = {
          index: entryIndex++,
          name: classification.normalized,
          size: info.size,
          kind: classification.kind,
          filePath,
        };
        const writer = createWriteStream(filePath, {
          flags: "wx",
          mode: 0o600,
        });
        const done = new Promise<void>((resolveDone, rejectDone) => {
          writer.once("finish", resolveDone);
          writer.once("error", rejectDone);
        });
        entries.push(staged);
        active = { info, staged, writer, done };
      },
      onEntryChunk: async (_info, chunk) => {
        if (!active?.writer) return;
        if (!active.writer.write(chunk)) {
          await once(active.writer, "drain");
        }
      },
      onEntryEnd: async () => {
        await closeActive(false);
      },
    });

    try {
      for await (const rawChunk of chunks) {
        const chunk =
          rawChunk instanceof Uint8Array
            ? rawChunk
            : new Uint8Array(rawChunk as ArrayBuffer);
        bytesRead += chunk.byteLength;
        await parser.write(chunk);
        options.onProgress?.({
          bytesRead,
          totalBytes: Math.max(0, options.totalBytes ?? 0),
          entryName: active?.info.name,
        });
      }
      parser.finish();
      return { entries, bytesRead, ignoredExtensionEntries };
    } catch (error) {
      await closeActive(true).catch(() => {});
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      if (error instanceof BackupImportStagingError) throw error;
      throw new BackupImportStagingError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async cleanup(id: string): Promise<void> {
    await fs.rm(this.jobDirectory(id), { recursive: true, force: true });
  }
}
