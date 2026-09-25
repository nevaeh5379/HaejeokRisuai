import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import {
  BackupContainerParser,
  type BackupContainerEntryInfo,
} from "../containerStream";
import { classifyBackupEntry, type BackupEntryKind } from "../entryPolicy";

type SupportedEntryKind = Exclude<
  BackupEntryKind,
  "invalid" | "extension" | "encryption"
>;

export const BACKUP_IMPORT_MAX_NAME_BYTES = 16 * 1024;
export const BACKUP_IMPORT_MAX_ENTRIES = 1_000_000;
export const BACKUP_IMPORT_MAX_NATIVE_DATABASE_ENTRY_BYTES = 64 * 1024 * 1024;
export const BACKUP_IMPORT_MAX_COLD_STORAGE_ENTRY_BYTES = 64 * 1024 * 1024;
export const BACKUP_IMPORT_MAX_LEGACY_DATABASE_ENTRY_BYTES = 256 * 1024 * 1024;

export interface StreamedBackupEntry {
  index: number;
  name: string;
  size: number;
  kind: SupportedEntryKind;
}

export interface BufferedBackupEntry extends StreamedBackupEntry {
  filePath: string;
}

/** @deprecated Import execution uses BackupImportStreamSession. */
export interface StagedBackupEntry extends BufferedBackupEntry {}

/** @deprecated Kept only for the pure import-plan compatibility helper. */
export interface StagedBackupContainer {
  entries: StagedBackupEntry[];
  bytesRead: number;
  ignoredExtensionEntries: number;
}

export interface BackupImportEntryWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export interface BackupImportStreamHandlers {
  onBufferedEntry(entry: BufferedBackupEntry): Promise<void>;
  openAssetEntry(entry: StreamedBackupEntry): Promise<BackupImportEntryWriter>;
  onProgress?(progress: {
    bytesRead: number;
    totalBytes: number;
    entryName?: string;
  }): void;
}

export interface StreamedBackupContainer {
  bytesRead: number;
  entriesHandled: number;
  ignoredExtensionEntries: number;
}

export class BackupImportStagingError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_job_id"
      | "invalid_entry"
      | "duplicate_entry"
      | "entry_limit_exceeded"
      | "buffered_entry_too_large"
      | "encrypted_backup_unsupported"
      | "staging_error" = "staging_error",
  ) {
    super(message);
    this.name = "BackupImportStagingError";
  }
}

interface ActiveEntry {
  info: BackupContainerEntryInfo;
  entry: StreamedBackupEntry | null;
  bufferedPath: string | null;
  fileWriter: ReturnType<typeof createWriteStream> | null;
  fileDone: Promise<void> | null;
  destination: BackupImportEntryWriter | null;
}

export class BackupImportStreamSession {
  private readonly seenNameDigests = new Set<string>();
  private readonly parser: BackupContainerParser;
  private active: ActiveEntry | null = null;
  private bytesRead = 0;
  private entriesHandled = 0;
  private ignoredExtensionEntries = 0;
  private entryIndex = 0;
  private finished = false;

  constructor(
    private readonly directory: string,
    private readonly handlers: BackupImportStreamHandlers,
    private readonly totalBytes: number,
    private readonly onDisposed: () => void,
  ) {
    this.parser = new BackupContainerParser(
      {
        onEntryStart: async (info: BackupContainerEntryInfo): Promise<void> =>
          await this.startEntry(info),
        onEntryChunk: async (
          _info: BackupContainerEntryInfo,
          chunk: Uint8Array,
        ): Promise<void> => await this.writeEntryChunk(chunk),
        onEntryEnd: async (): Promise<void> => await this.endEntry(),
      },
      { maxNameBytes: BACKUP_IMPORT_MAX_NAME_BYTES },
    );
  }

  private async startEntry(info: BackupContainerEntryInfo): Promise<void> {
    const classification = classifyBackupEntry(info.name);
    if (classification.kind === "invalid" || !classification.normalized) {
      throw new BackupImportStagingError(
        `Invalid backup entry path: ${info.name}`,
        "invalid_entry",
      );
    }
    const name = classification.normalized;
    if (this.seenNameDigests.size >= BACKUP_IMPORT_MAX_ENTRIES) {
      throw new BackupImportStagingError(
        `Backup contains more than ${BACKUP_IMPORT_MAX_ENTRIES} entries`,
        "entry_limit_exceeded",
      );
    }
    const nameDigest = createHash("sha256").update(name).digest("base64url");
    if (this.seenNameDigests.has(nameDigest)) {
      throw new BackupImportStagingError(
        `Backup contains duplicate entry '${name}'`,
        "duplicate_entry",
      );
    }
    this.seenNameDigests.add(nameDigest);

    if (classification.kind === "encryption") {
      throw new BackupImportStagingError(
        "Account-encrypted backups are intentionally unsupported.",
        "encrypted_backup_unsupported",
      );
    }
    if (classification.kind === "extension") {
      this.ignoredExtensionEntries++;
      this.active = {
        info,
        entry: null,
        bufferedPath: null,
        fileWriter: null,
        fileDone: null,
        destination: null,
      };
      return;
    }

    const bufferedLimit =
      classification.kind === "database"
        ? BACKUP_IMPORT_MAX_LEGACY_DATABASE_ENTRY_BYTES
        : classification.kind === "databaseStream"
          ? BACKUP_IMPORT_MAX_NATIVE_DATABASE_ENTRY_BYTES
          : classification.kind === "coldStorage"
            ? BACKUP_IMPORT_MAX_COLD_STORAGE_ENTRY_BYTES
            : null;
    if (bufferedLimit !== null && info.size > bufferedLimit) {
      throw new BackupImportStagingError(
        `Backup entry '${name}' exceeds the ${bufferedLimit}-byte buffered-entry limit`,
        "buffered_entry_too_large",
      );
    }

    const entry: StreamedBackupEntry = {
      index: this.entryIndex++,
      name,
      size: info.size,
      kind: classification.kind,
    };
    if (entry.kind === "asset" || entry.kind === "inlay") {
      this.active = {
        info,
        entry,
        bufferedPath: null,
        fileWriter: null,
        fileDone: null,
        destination: await this.handlers.openAssetEntry(entry),
      };
      return;
    }

    const bufferedPath = join(this.directory, "current-entry.part");
    await fs.rm(bufferedPath, { force: true });
    const fileWriter = createWriteStream(bufferedPath, {
      flags: "wx",
      mode: 0o600,
    });
    const fileDone = new Promise<void>((resolveDone, rejectDone) => {
      fileWriter.once("close", resolveDone);
      fileWriter.once("error", rejectDone);
    });
    this.active = {
      info,
      entry,
      bufferedPath,
      fileWriter,
      fileDone,
      destination: null,
    };
  }

  private async writeEntryChunk(chunk: Uint8Array): Promise<void> {
    if (this.active?.destination) {
      await this.active.destination.write(chunk);
      return;
    }
    if (this.active?.fileWriter && !this.active.fileWriter.write(chunk)) {
      await once(this.active.fileWriter, "drain");
    }
  }

  private async endEntry(): Promise<void> {
    const current = this.active;
    this.active = null;
    if (!current?.entry) return;

    if (current.destination) {
      await current.destination.close();
      this.entriesHandled++;
      return;
    }
    if (!current.fileWriter || !current.fileDone || !current.bufferedPath) {
      throw new BackupImportStagingError(
        `Backup entry ${current.entry.name} lost its destination`,
      );
    }
    current.fileWriter.end();
    await current.fileDone;
    try {
      await this.handlers.onBufferedEntry({
        ...current.entry,
        filePath: current.bufferedPath,
      });
      this.entriesHandled++;
    } finally {
      await fs.rm(current.bufferedPath, { force: true }).catch(() => {});
    }
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.finished) {
      throw new BackupImportStagingError("Backup parser is already finished");
    }
    this.bytesRead += chunk.byteLength;
    await this.parser.write(chunk);
    this.handlers.onProgress?.({
      bytesRead: this.bytesRead,
      totalBytes: this.totalBytes,
      entryName: this.active?.info.name,
    });
  }

  async writeAll(chunks: AsyncIterable<Uint8Array>): Promise<void> {
    for await (const rawChunk of chunks) {
      await this.write(
        rawChunk instanceof Uint8Array
          ? rawChunk
          : new Uint8Array(rawChunk as ArrayBuffer),
      );
    }
  }

  async finish(): Promise<StreamedBackupContainer> {
    if (this.finished) {
      throw new BackupImportStagingError("Backup parser is already finished");
    }
    this.parser.finish();
    this.finished = true;
    await this.disposeDirectory();
    return {
      bytesRead: this.bytesRead,
      entriesHandled: this.entriesHandled,
      ignoredExtensionEntries: this.ignoredExtensionEntries,
    };
  }

  async abort(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const current = this.active;
    this.active = null;
    current?.fileWriter?.destroy();
    await current?.fileDone?.catch(() => {});
    await current?.destination?.abort().catch(() => {});
    await this.disposeDirectory();
  }

  private async disposeDirectory(): Promise<void> {
    await fs.rm(this.directory, { recursive: true, force: true });
    this.onDisposed();
  }
}

/**
 * Owns only current-entry scratch space. Asset bodies are sent directly to the
 * destination supplied by the restore adapter and are never staged here.
 */
export class BackupImportStagingStore {
  private readonly rootPath: string;
  private readonly jobDirectories = new Map<string, string>();

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
  }

  private validateJobId(id: string): void {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
      throw new BackupImportStagingError(
        "Invalid local backup import job id",
        "invalid_job_id",
      );
    }
  }

  async createSession(
    id: string,
    handlers: BackupImportStreamHandlers,
    options: { totalBytes?: number } = {},
  ): Promise<BackupImportStreamSession> {
    this.validateJobId(id);
    if (this.jobDirectories.has(id)) {
      throw new BackupImportStagingError(
        "A backup parser session already exists for this job",
      );
    }
    const directory = join(this.rootPath, randomUUID());
    await fs.mkdir(directory, { recursive: true });
    this.jobDirectories.set(id, directory);
    return new BackupImportStreamSession(
      directory,
      handlers,
      Math.max(0, options.totalBytes ?? 0),
      () => {
        if (this.jobDirectories.get(id) === directory) {
          this.jobDirectories.delete(id);
        }
      },
    );
  }

  async cleanup(id: string): Promise<void> {
    this.validateJobId(id);
    const directory = this.jobDirectories.get(id);
    this.jobDirectories.delete(id);
    if (directory) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
}
