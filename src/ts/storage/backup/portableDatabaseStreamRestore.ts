import {
  PORTABLE_DATABASE_STREAM_MAX_FRAGMENT_RECORDS,
  type PortableDatabaseStreamFragment,
  type PortableDatabaseStreamManifest,
  type PortableDatabaseStreamPersistedRecord,
} from "./portableDatabaseStream";

export interface PortableDatabaseStreamRestoreProgress {
  appliedRecords: number;
  recordType?: PortableDatabaseStreamPersistedRecord["type"];
}

export interface PortableDatabaseStreamRestoreSession {
  writeFragment(fragment: PortableDatabaseStreamFragment): Promise<void>;
  finish(manifest: PortableDatabaseStreamManifest): Promise<void>;
  abort(): Promise<void>;
}

export interface PortableDatabaseStreamRestoreCapable {
  beginPortableDatabaseStreamRestore(
    onProgress?: (progress: PortableDatabaseStreamRestoreProgress) => void,
  ): Promise<PortableDatabaseStreamRestoreSession>;
}

export function hasPortableDatabaseStreamRestore(
  storage: unknown,
): storage is PortableDatabaseStreamRestoreCapable {
  return Boolean(
    storage &&
      typeof storage === "object" &&
      typeof (storage as PortableDatabaseStreamRestoreCapable)
        .beginPortableDatabaseStreamRestore === "function",
  );
}
const RECORD_TYPES: PortableDatabaseStreamPersistedRecord["type"][] = [
  "meta",
  "setting",
  "plugin-storage",
  "module",
  "preset",
  "character",
  "chat",
  "branch",
  "active-branch",
  "message",
];

function increment(
  counts: Partial<
    Record<PortableDatabaseStreamPersistedRecord["type"], number>
  >,
  type: PortableDatabaseStreamPersistedRecord["type"],
) {
  counts[type] = (counts[type] ?? 0) + 1;
}

export class PortableDatabaseStreamValidator {
  private readonly fragments = new Set<number>();
  private readonly counts: Partial<
    Record<PortableDatabaseStreamPersistedRecord["type"], number>
  > = {};
  private totalRecords = 0;
  private sourceRevision: number | null = null;

  acceptFragment(fragment: PortableDatabaseStreamFragment): void {
    if (
      fragment.format !== "risu-portable-database-fragment" ||
      fragment.version !== 1 ||
      !Number.isSafeInteger(fragment.index) ||
      fragment.index <= 0 ||
      !Array.isArray(fragment.records) ||
      fragment.records.length === 0 ||
      fragment.records.length > PORTABLE_DATABASE_STREAM_MAX_FRAGMENT_RECORDS
    ) {
      throw new Error("Invalid streaming database fragment");
    }
    if (this.fragments.has(fragment.index)) {
      throw new Error(
        `Duplicate streaming database fragment ${fragment.index}`,
      );
    }
    this.fragments.add(fragment.index);
    for (const record of fragment.records) {
      this.acceptRecord(record);
    }
  }

  private acceptRecord(record: PortableDatabaseStreamPersistedRecord): void {
    if (!record || typeof record !== "object" || !RECORD_TYPES.includes(record.type)) {
      throw new Error("Invalid streaming database record");
    }
    this.totalRecords++;
    increment(this.counts, record.type);
    if (record.type !== "meta") return;
    if (this.sourceRevision !== null) {
      throw new Error("Duplicate streaming database metadata");
    }
    if (
      record.formatVersion !== 1 ||
      !Number.isSafeInteger(record.revision) ||
      record.revision < 0
    ) {
      throw new Error("Invalid streaming database metadata");
    }
    this.sourceRevision = record.revision;
  }

  finish(manifest: PortableDatabaseStreamManifest): void {
    if (
      manifest.format !== "risu-portable-database-stream" ||
      manifest.version !== 1 ||
      manifest.complete !== true ||
      !Number.isSafeInteger(manifest.revision) ||
      manifest.revision < 0 ||
      !Number.isSafeInteger(manifest.totalFragments) ||
      manifest.totalFragments <= 0 ||
      !Number.isSafeInteger(manifest.totalRecords) ||
      manifest.totalRecords <= 0 ||
      !manifest.counts ||
      typeof manifest.counts !== "object"
    ) {
      throw new Error("Unsupported streaming database manifest");
    }
    if (
      manifest.totalFragments !== this.fragments.size ||
      manifest.totalRecords !== this.totalRecords
    ) {
      throw new Error(
        `Streaming database is incomplete (${this.fragments.size}/${manifest.totalFragments} fragments, ${this.totalRecords}/${manifest.totalRecords} records)`,
      );
    }
    for (let index = 1; index <= manifest.totalFragments; index++) {
      if (!this.fragments.has(index)) {
        throw new Error(`Streaming database fragment ${index} is missing`);
      }
    }
    if (this.sourceRevision !== manifest.revision) {
      throw new Error("Streaming database revision does not match");
    }
    for (const type of RECORD_TYPES) {
      if ((manifest.counts[type] ?? 0) !== (this.counts[type] ?? 0)) {
        throw new Error(`Streaming database ${type} count does not match`);
      }
    }
  }
}
