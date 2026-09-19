import { createReadStream, promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import type { LocalBackupImportUploadState } from "../api";

export class BackupImportUploadError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_job_id"
      | "invalid_offset"
      | "invalid_total_bytes"
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

export interface BackupImportUploadFinalizeSource {
  filePath: string;
  totalBytes: number;
  stream: AsyncIterable<Uint8Array>;
}

export class BackupImportUploadStore {
  private readonly rootPath: string;
  private readonly totals = new Map<string, number>();
  private readonly sealed = new Set<string>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
  }

  private uploadPath(id: string): string {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
      throw new BackupImportUploadError(
        "Invalid local backup import job id",
        "invalid_job_id",
      );
    }
    return join(this.rootPath, `${id}.upload`);
  }

  private async serialized<T>(
    id: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const queued = previous.catch(() => {}).then(() => gate);
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

  async append(
    id: string,
    offset: number,
    chunks: AsyncIterable<Uint8Array>,
    totalBytes: number,
  ): Promise<LocalBackupImportUploadState> {
    this.validateRange(offset, totalBytes);
    return await this.serialized(id, async () => {
      if (this.sealed.has(id)) {
        throw new BackupImportUploadError(
          "Backup upload was already finalized",
          "upload_finalized",
        );
      }
      const filePath = this.uploadPath(id);
      await fs.mkdir(this.rootPath, { recursive: true });
      const stat = await fs
        .stat(filePath)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
      const currentSize = stat?.size ?? 0;
      if (currentSize !== offset) {
        throw new BackupImportUploadError(
          `Backup upload offset mismatch: expected ${currentSize}, received ${offset}`,
          "upload_offset_mismatch",
          currentSize,
        );
      }

      const knownTotal = this.totals.get(id);
      if (knownTotal !== undefined && knownTotal !== totalBytes) {
        throw new BackupImportUploadError(
          "Backup upload total size changed during the upload",
          "invalid_total_bytes",
        );
      }
      this.totals.set(id, totalBytes);

      const handle = await fs.open(
        filePath,
        currentSize === 0 ? "w+" : "r+",
        0o600,
      );
      let position = offset;
      try {
        for await (const rawChunk of chunks) {
          const chunk =
            rawChunk instanceof Uint8Array
              ? rawChunk
              : new Uint8Array(rawChunk as ArrayBuffer);
          if (position + chunk.byteLength > totalBytes) {
            throw new BackupImportUploadError(
              "Backup upload exceeded the declared total size",
              "invalid_total_bytes",
            );
          }
          let chunkOffset = 0;
          while (chunkOffset < chunk.byteLength) {
            const { bytesWritten } = await handle.write(
              chunk,
              chunkOffset,
              chunk.byteLength - chunkOffset,
              position,
            );
            if (bytesWritten <= 0) {
              throw new BackupImportUploadError(
                "Backup upload stopped while writing a chunk",
                "upload_error",
              );
            }
            chunkOffset += bytesWritten;
            position += bytesWritten;
          }
        }
      } catch (error) {
        await handle.truncate(offset).catch(() => {});
        if (error instanceof BackupImportUploadError) throw error;
        throw new BackupImportUploadError(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        await handle.close();
      }

      return {
        receivedBytes: position,
        totalBytes,
        complete: position === totalBytes,
      };
    });
  }

  async finalize(id: string): Promise<BackupImportUploadFinalizeSource> {
    return await this.serialized(id, async () => {
      const filePath = this.uploadPath(id);
      const totalBytes = this.totals.get(id);
      if (!totalBytes) {
        throw new BackupImportUploadError(
          "Backup upload was not started",
          "upload_incomplete",
        );
      }
      const stat = await fs.stat(filePath).catch(() => null);
      const receivedBytes = stat?.size ?? 0;
      if (receivedBytes !== totalBytes) {
        throw new BackupImportUploadError(
          `Backup upload is incomplete: ${receivedBytes} / ${totalBytes} bytes`,
          "upload_incomplete",
          receivedBytes,
        );
      }
      this.sealed.add(id);
      return {
        filePath,
        totalBytes,
        stream: createReadStream(filePath),
      };
    });
  }

  async cleanup(id: string): Promise<void> {
    await this.serialized(id, async () => {
      const filePath = this.uploadPath(id);
      this.totals.delete(id);
      this.sealed.delete(id);
      await fs.rm(filePath, { force: true });
    });
  }
}
