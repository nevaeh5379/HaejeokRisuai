import { randomUUID } from "node:crypto";
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

interface BackupImportUploadSegment {
  filePath: string;
  offset: number;
  size: number;
}

export interface BackupImportUploadFinalizeSource {
  totalBytes: number;
  stream: AsyncIterable<Uint8Array>;
}

export class BackupImportUploadStore {
  private readonly rootPath: string;
  private readonly totals = new Map<string, number>();
  private readonly receivedBytes = new Map<string, number>();
  private readonly uploadDirectories = new Map<string, string>();
  private readonly segments = new Map<string, BackupImportUploadSegment[]>();
  private readonly sealed = new Set<string>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
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

  /**
   * Drain sealed upload segments in order and remove each segment only after
   * the downstream parser has consumed it. Staging therefore replaces upload
   * bytes instead of duplicating the complete backup on disk.
   */
  private async *consumeSegments(
    directory: string,
    uploadSegments: readonly BackupImportUploadSegment[],
  ): AsyncGenerator<Uint8Array> {
    try {
      for (const segment of uploadSegments) {
        try {
          for await (const chunk of createReadStream(segment.filePath)) {
            yield chunk;
          }
        } finally {
          await fs.rm(segment.filePath, { force: true }).catch(() => {});
        }
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  async append(
    id: string,
    offset: number,
    chunks: AsyncIterable<Uint8Array>,
    totalBytes: number,
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

        const currentSize: number = this.receivedBytes.get(id) ?? 0;
        if (currentSize !== offset) {
          throw new BackupImportUploadError(
            `Backup upload offset mismatch: expected ${currentSize}, received ${offset}`,
            "upload_offset_mismatch",
            currentSize,
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

        const directory: string = this.getUploadDirectory(id, true)!;
        await fs.mkdir(directory, { recursive: true });
        const segmentPath: string = join(
          directory,
          `${String(offset).padStart(16, "0")}-${randomUUID()}.chunk`,
        );
        const handle = await fs.open(segmentPath, "wx", 0o600);
        let segmentSize = 0;

        try {
          for await (const rawChunk of chunks) {
            const chunk: Uint8Array =
              rawChunk instanceof Uint8Array
                ? rawChunk
                : new Uint8Array(rawChunk as ArrayBuffer);
            if (offset + segmentSize + chunk.byteLength > totalBytes) {
              throw new BackupImportUploadError(
                "Backup upload exceeded the declared total size",
                "invalid_total_bytes",
              );
            }

            let chunkOffset = 0;
            while (chunkOffset < chunk.byteLength) {
              const { bytesWritten }: { bytesWritten: number } =
                await handle.write(
                  chunk,
                  chunkOffset,
                  chunk.byteLength - chunkOffset,
                  segmentSize,
                );
              if (bytesWritten <= 0) {
                throw new BackupImportUploadError(
                  "Backup upload stopped while writing a chunk",
                  "upload_error",
                );
              }
              chunkOffset += bytesWritten;
              segmentSize += bytesWritten;
            }
          }
        } catch (error) {
          await handle.close().catch(() => {});
          await fs.rm(segmentPath, { force: true }).catch(() => {});
          if (error instanceof BackupImportUploadError) throw error;
          throw new BackupImportUploadError(
            error instanceof Error ? error.message : String(error),
          );
        }

        await handle.close();
        const position: number = offset + segmentSize;
        if (segmentSize > 0) {
          const uploadSegments: BackupImportUploadSegment[] =
            this.segments.get(id) ?? [];
          uploadSegments.push({
            filePath: segmentPath,
            offset,
            size: segmentSize,
          });
          this.segments.set(id, uploadSegments);
        } else {
          await fs.rm(segmentPath, { force: true }).catch(() => {});
        }
        this.receivedBytes.set(id, position);

        return {
          receivedBytes: position,
          totalBytes,
          complete: position === totalBytes,
        };
      },
    );
  }

  async finalize(id: string): Promise<BackupImportUploadFinalizeSource> {
    return await this.serialized(
      id,
      async (): Promise<BackupImportUploadFinalizeSource> => {
        if (this.sealed.has(id)) {
          throw new BackupImportUploadError(
            "Backup upload was already finalized",
            "upload_finalized",
          );
        }

        const directory: string | null = this.getUploadDirectory(id, false);
        const totalBytes: number | undefined = this.totals.get(id);
        const receivedBytes: number = this.receivedBytes.get(id) ?? 0;
        if (!directory || !totalBytes) {
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

        const uploadSegments: BackupImportUploadSegment[] = [
          ...(this.segments.get(id) ?? []),
        ].sort((left, right) => left.offset - right.offset);
        let expectedOffset = 0;
        for (const segment of uploadSegments) {
          if (segment.offset !== expectedOffset) {
            throw new BackupImportUploadError(
              `Backup upload segment gap: expected ${expectedOffset}, received ${segment.offset}`,
              "upload_incomplete",
              expectedOffset,
            );
          }
          expectedOffset += segment.size;
        }
        if (expectedOffset !== totalBytes) {
          throw new BackupImportUploadError(
            `Backup upload is incomplete: ${expectedOffset} / ${totalBytes} bytes`,
            "upload_incomplete",
            expectedOffset,
          );
        }

        this.sealed.add(id);
        return {
          totalBytes,
          stream: this.consumeSegments(directory, uploadSegments),
        };
      },
    );
  }

  async cleanup(id: string): Promise<void> {
    await this.serialized(id, async (): Promise<void> => {
      const directory: string | null = this.getUploadDirectory(id, false);
      this.totals.delete(id);
      this.receivedBytes.delete(id);
      this.uploadDirectories.delete(id);
      this.segments.delete(id);
      this.sealed.delete(id);
      if (directory) {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
  }
}
