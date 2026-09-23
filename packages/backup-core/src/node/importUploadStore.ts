import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import type { LocalBackupImportUploadState } from "../api";

export const DEFAULT_BACKUP_IMPORT_REQUEST_BYTES = 8 * 1024 * 1024;

export class BackupImportUploadError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_job_id"
      | "invalid_offset"
      | "invalid_total_bytes"
      | "upload_request_too_large"
      | "upload_offset_mismatch"
      | "upload_incomplete"
      | "upload_finalized"
      | "upload_error" = "upload_error",
    readonly expectedOffset?: number,
  ) {
    super(message);
    this.name = "BackupImportUploadError";
  }
}

interface AcceptedUploadRequest {
  offset: number;
  size: number;
  sha256: string;
}

interface SpoolResult {
  filePath: string;
  size: number;
  sha256: string;
}

export type BackupImportUploadConsumer = (
  chunks: AsyncIterable<Uint8Array>,
) => Promise<void>;

/**
 * Resumable request spool for streaming imports.
 *
 * At most one request body is kept on disk. A request is first completed and
 * hashed, then passed to the long-lived container parser, and finally removed.
 * This preserves request retry safety without retaining an upload-sized copy.
 */
export class BackupImportUploadStore {
  private readonly rootPath: string;
  private readonly totals = new Map<string, number>();
  private readonly receivedBytes = new Map<string, number>();
  private readonly uploadDirectories = new Map<string, string>();
  private readonly lastAccepted = new Map<string, AcceptedUploadRequest>();
  private readonly sealed = new Set<string>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    rootPath: string,
    private readonly maxRequestBytes = DEFAULT_BACKUP_IMPORT_REQUEST_BYTES,
  ) {
    this.rootPath = resolve(rootPath);
    if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0) {
      throw new TypeError(
        "Backup upload request limit must be a positive integer",
      );
    }
  }

  private validateJobId(id: string): void {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
      throw new BackupImportUploadError(
        "Invalid local backup import job id",
        "invalid_job_id",
      );
    }
  }

  private getUploadDirectory(id: string, create: boolean): string | null {
    this.validateJobId(id);
    const existing: string | undefined = this.uploadDirectories.get(id);
    if (existing) return existing;
    if (!create) return null;
    const directory: string = join(this.rootPath, `${randomUUID()}.upload`);
    this.uploadDirectories.set(id, directory);
    return directory;
  }

  private async serialized<T>(
    id: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous: Promise<void> = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate: Promise<void> = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const queued: Promise<void> = previous.catch(() => {}).then(() => gate);
    this.locks.set(id, queued);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(id) === queued) this.locks.delete(id);
    }
  }

  private validateRange(offset: number, totalBytes: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new BackupImportUploadError(
        "Backup upload offset must be a non-negative safe integer",
        "invalid_offset",
      );
    }
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
      throw new BackupImportUploadError(
        "Backup upload total size must be a positive safe integer",
        "invalid_total_bytes",
      );
    }
    if (offset > totalBytes) {
      throw new BackupImportUploadError(
        "Backup upload offset exceeds the declared total size",
        "invalid_offset",
      );
    }
  }

  private async spoolRequest(
    directory: string,
    offset: number,
    chunks: AsyncIterable<Uint8Array>,
    totalBytes: number,
  ): Promise<SpoolResult> {
    await fs.mkdir(directory, { recursive: true });
    const filePath: string = join(directory, `${randomUUID()}.chunk`);
    const handle = await fs.open(filePath, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;

    try {
      for await (const rawChunk of chunks) {
        const chunk: Uint8Array =
          rawChunk instanceof Uint8Array
            ? rawChunk
            : new Uint8Array(rawChunk as ArrayBuffer);
        if (offset + size + chunk.byteLength > totalBytes) {
          throw new BackupImportUploadError(
            "Backup upload exceeded the declared total size",
            "invalid_total_bytes",
          );
        }
        if (size + chunk.byteLength > this.maxRequestBytes) {
          throw new BackupImportUploadError(
            `Backup upload request exceeds ${this.maxRequestBytes} bytes`,
            "upload_request_too_large",
          );
        }
        hash.update(chunk);
        let chunkOffset = 0;
        while (chunkOffset < chunk.byteLength) {
          const { bytesWritten }: { bytesWritten: number } = await handle.write(
            chunk,
            chunkOffset,
            chunk.byteLength - chunkOffset,
            size,
          );
          if (bytesWritten <= 0) {
            throw new BackupImportUploadError(
              "Backup upload stopped while writing a chunk",
              "upload_error",
            );
          }
          chunkOffset += bytesWritten;
          size += bytesWritten;
        }
      }
      await handle.close();
      return { filePath, size, sha256: hash.digest("hex") };
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.rm(filePath, { force: true }).catch(() => {});
      if (error instanceof BackupImportUploadError) throw error;
      throw new BackupImportUploadError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async append(
    id: string,
    offset: number,
    chunks: AsyncIterable<Uint8Array>,
    totalBytes: number,
    consume: BackupImportUploadConsumer,
  ): Promise<LocalBackupImportUploadState> {
    this.validateRange(offset, totalBytes);
    return await this.serialized(
      id,
      async (): Promise<LocalBackupImportUploadState> => {
        if (this.sealed.has(id)) {
          throw new BackupImportUploadError(
            "Backup upload was already finalized",
            "upload_finalized",
          );
        }
        const knownTotal: number | undefined = this.totals.get(id);
        if (knownTotal !== undefined && knownTotal !== totalBytes) {
          throw new BackupImportUploadError(
            "Backup upload total size changed during the upload",
            "invalid_total_bytes",
          );
        }
        this.totals.set(id, totalBytes);

        const currentSize: number = this.receivedBytes.get(id) ?? 0;
        const directory: string = this.getUploadDirectory(id, true)!;
        const spooled: SpoolResult = await this.spoolRequest(
          directory,
          offset,
          chunks,
          totalBytes,
        );
        try {
          if (offset !== currentSize) {
            const accepted: AcceptedUploadRequest | undefined =
              this.lastAccepted.get(id);
            if (
              accepted &&
              accepted.offset === offset &&
              accepted.size === spooled.size &&
              accepted.sha256 === spooled.sha256 &&
              offset + spooled.size === currentSize
            ) {
              return {
                receivedBytes: currentSize,
                totalBytes,
                complete: currentSize === totalBytes,
              };
            }
            throw new BackupImportUploadError(
              `Backup upload offset mismatch: expected ${currentSize}, received ${offset}`,
              "upload_offset_mismatch",
              currentSize,
            );
          }

          if (spooled.size === 0 && currentSize !== totalBytes) {
            throw new BackupImportUploadError(
              "Backup upload request did not contain any bytes",
              "upload_error",
            );
          }
          await consume(createReadStream(spooled.filePath));
          const position: number = offset + spooled.size;
          this.receivedBytes.set(id, position);
          this.lastAccepted.set(id, {
            offset,
            size: spooled.size,
            sha256: spooled.sha256,
          });
          return {
            receivedBytes: position,
            totalBytes,
            complete: position === totalBytes,
          };
        } finally {
          await fs.rm(spooled.filePath, { force: true }).catch(() => {});
        }
      },
    );
  }

  async finalize(id: string): Promise<LocalBackupImportUploadState> {
    return await this.serialized(
      id,
      async (): Promise<LocalBackupImportUploadState> => {
        if (this.sealed.has(id)) {
          throw new BackupImportUploadError(
            "Backup upload was already finalized",
            "upload_finalized",
          );
        }
        const totalBytes: number | undefined = this.totals.get(id);
        const receivedBytes: number = this.receivedBytes.get(id) ?? 0;
        if (!totalBytes) {
          throw new BackupImportUploadError(
            "Backup upload was not started",
            "upload_incomplete",
          );
        }
        if (receivedBytes !== totalBytes) {
          throw new BackupImportUploadError(
            `Backup upload is incomplete: ${receivedBytes} / ${totalBytes} bytes`,
            "upload_incomplete",
            receivedBytes,
          );
        }
        this.sealed.add(id);
        return { receivedBytes, totalBytes, complete: true };
      },
    );
  }

  async cleanup(id: string): Promise<void> {
    await this.serialized(id, async (): Promise<void> => {
      const directory: string | null = this.getUploadDirectory(id, false);
      this.totals.delete(id);
      this.receivedBytes.delete(id);
      this.uploadDirectories.delete(id);
      this.lastAccepted.delete(id);
      this.sealed.delete(id);
      if (directory) {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
  }
}
