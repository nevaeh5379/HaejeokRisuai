import {
  LOCAL_BACKUP_DATABASE_RECORD_TYPES,
  LOCAL_BACKUP_DATABASE_STREAM_MAX_FRAGMENT_RECORDS,
} from "./databaseStreamStore";
import { createLocalBackupEntryHeader } from "./legacyFormat";
import type { LegacyBackupSqlRecord } from "../legacyRecords";
import {
  PORTABLE_DATABASE_STREAM_MANIFEST,
  PORTABLE_DATABASE_STREAM_PREFIX,
  PORTABLE_DATABASE_STREAM_VERSION,
  portableDatabaseStreamFragmentName,
  type PortableDatabaseStreamManifest,
} from "../streamFormat";

export {
  PORTABLE_DATABASE_STREAM_MANIFEST,
  PORTABLE_DATABASE_STREAM_PREFIX,
  PORTABLE_DATABASE_STREAM_VERSION,
} from "../streamFormat";
export type { PortableDatabaseStreamManifest } from "../streamFormat";
export const PORTABLE_DATABASE_STREAM_DEFAULT_FRAGMENT_RECORDS = 128;
export const databaseFragmentName = portableDatabaseStreamFragmentName;

export type BackupEntrySource = Uint8Array | AsyncIterable<Uint8Array>;

export type BackupChunkWriter = (chunk: Uint8Array) => Promise<void>;

export interface PortableDatabaseExportWriterOptions {
  revision: number;
  expectedRecords?: number;
  fragmentRecords?: number;
  encodeDatabase(value: unknown): Promise<Uint8Array>;
  writeEntry(
    name: string,
    source: BackupEntrySource,
    size: number,
  ): Promise<void>;
  onRecord?: (record: LegacyBackupSqlRecord) => void;
  onProgress?: (current: number, total: number) => void;
}

export async function writeBackupContainerEntry(
  writeChunk: BackupChunkWriter,
  name: string,
  source: BackupEntrySource,
  size: number,
): Promise<void> {
  await writeChunk(createLocalBackupEntryHeader(name, size));
  if (source instanceof Uint8Array) {
    await writeChunk(source);
    return;
  }
  for await (const chunk of source) {
    await writeChunk(
      chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk),
    );
  }
}

function normalizeFragmentRecords(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return PORTABLE_DATABASE_STREAM_DEFAULT_FRAGMENT_RECORDS;
  }
  return Math.max(
    1,
    Math.min(
      LOCAL_BACKUP_DATABASE_STREAM_MAX_FRAGMENT_RECORDS,
      Math.round(numeric),
    ),
  );
}

function createCounts(): Record<string, number> {
  return Object.fromEntries(
    LOCAL_BACKUP_DATABASE_RECORD_TYPES.map((type) => [type, 0]),
  );
}

export class PortableDatabaseExportWriter {
  private readonly counts = createCounts();
  private readonly fragmentRecordLimit: number;
  private readonly expectedRecords: number;
  private fragmentIndex = 0;
  private totalRecords = 0;
  private fragmentRecords: LegacyBackupSqlRecord[] = [];

  constructor(private readonly options: PortableDatabaseExportWriterOptions) {
    if (!Number.isSafeInteger(options.revision) || options.revision < 0) {
      throw new TypeError("Portable database revision must be non-negative");
    }
    this.fragmentRecordLimit = normalizeFragmentRecords(
      options.fragmentRecords,
    );
    this.expectedRecords = Math.max(
      0,
      Number.isSafeInteger(options.expectedRecords)
        ? Number(options.expectedRecords)
        : 0,
    );
  }

  private async flush(): Promise<void> {
    if (this.fragmentRecords.length === 0) return;
    const fragment = {
      format: "risu-portable-database-fragment",
      version: PORTABLE_DATABASE_STREAM_VERSION,
      index: ++this.fragmentIndex,
      records: this.fragmentRecords,
    };
    this.fragmentRecords = [];
    const encoded = await this.options.encodeDatabase(fragment);
    await this.options.writeEntry(
      portableDatabaseStreamFragmentName(fragment.index),
      encoded,
      encoded.byteLength,
    );
  }

  async emit(record: LegacyBackupSqlRecord): Promise<void> {
    if (
      !record ||
      typeof record.type !== "string" ||
      !(LOCAL_BACKUP_DATABASE_RECORD_TYPES as readonly string[]).includes(
        record.type,
      )
    ) {
      throw new Error(
        `Unsupported portable database record type '${String(record?.type)}'`,
      );
    }
    this.fragmentRecords.push(record);
    this.totalRecords++;
    this.counts[record.type] = (this.counts[record.type] ?? 0) + 1;
    this.options.onRecord?.(record);
    this.options.onProgress?.(this.totalRecords, this.expectedRecords);
    if (this.fragmentRecords.length >= this.fragmentRecordLimit) {
      await this.flush();
    }
  }

  async finalize(): Promise<PortableDatabaseStreamManifest> {
    await this.flush();
    return {
      format: "risu-portable-database-stream",
      version: PORTABLE_DATABASE_STREAM_VERSION,
      revision: this.options.revision,
      totalFragments: this.fragmentIndex,
      totalRecords: this.totalRecords,
      counts: { ...this.counts },
      complete: true,
    };
  }
}
