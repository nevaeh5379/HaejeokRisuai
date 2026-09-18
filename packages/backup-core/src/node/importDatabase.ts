import { once } from "node:events";
import { createWriteStream, promises as fs } from "node:fs";
import {
  LOCAL_BACKUP_DATABASE_RECORD_TYPES,
  LOCAL_BACKUP_DATABASE_STREAM_MAX_FRAGMENT_RECORDS,
} from "./databaseStreamStore";
import {
  decodeLegacyBackupDatabase,
} from "./legacyFormat";
import {
  LegacyBackupStreamingUnsupportedError,
  streamLegacyBackupDatabaseToSqlNdjson,
  type StreamLegacyBackupOptions,
} from "./legacyStream";
import {
  iterateLegacyBackupSqlRecords,
  type LegacyBackupSqlRecord,
} from "../legacyRecords";
import type { BackupImportPlan } from "./importPlan";

export interface PreparedLocalBackupDatabase {
  sourceRevision: number;
  recordCount: number;
  filePath: string;
}

export interface LocalBackupDatabasePreparationProgress {
  current: number;
  total: number;
  detail?: string;
}

export interface LocalBackupDatabasePreparationOptions {
  encodeRecord: (record: LegacyBackupSqlRecord) => unknown;
  idFactory: () => string;
  onProgress?: (
    progress: LocalBackupDatabasePreparationProgress,
  ) => void;
}

interface PortableDatabaseStreamManifest {
  format: "risu-portable-database-stream";
  version: 1;
  revision: number;
  totalFragments: number;
  totalRecords: number;
  counts: Record<string, number | undefined>;
  complete: true;
}

interface PortableDatabaseStreamFragment {
  format: "risu-portable-database-fragment";
  version: 1;
  index: number;
  records: LegacyBackupSqlRecord[];
}

function requireObject(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, any>;
}

function decodeManifest(data: unknown): PortableDatabaseStreamManifest {
  const manifest = requireObject(data, "Portable database stream manifest");
  if (
    manifest.format !== "risu-portable-database-stream" ||
    manifest.version !== 1 ||
    manifest.complete !== true ||
    !Number.isSafeInteger(manifest.revision) ||
    Number(manifest.revision) < 0 ||
    !Number.isSafeInteger(manifest.totalFragments) ||
    Number(manifest.totalFragments) <= 0 ||
    !Number.isSafeInteger(manifest.totalRecords) ||
    Number(manifest.totalRecords) <= 0 ||
    !manifest.counts ||
    typeof manifest.counts !== "object" ||
    Array.isArray(manifest.counts)
  ) {
    throw new Error("Portable database stream manifest is invalid");
  }
  return manifest as PortableDatabaseStreamManifest;
}

function decodeFragment(
  data: unknown,
  expectedIndex: number,
  name: string,
): PortableDatabaseStreamFragment {
  const fragment = requireObject(data, `Portable database fragment ${name}`);
  if (
    fragment.format !== "risu-portable-database-fragment" ||
    fragment.version !== 1 ||
    fragment.index !== expectedIndex ||
    !Array.isArray(fragment.records) ||
    fragment.records.length === 0 ||
    fragment.records.length > LOCAL_BACKUP_DATABASE_STREAM_MAX_FRAGMENT_RECORDS
  ) {
    throw new Error(`Invalid portable database fragment: ${name}`);
  }
  return fragment as PortableDatabaseStreamFragment;
}

async function writeRecordLine(
  output: ReturnType<typeof createWriteStream>,
  encoded: unknown,
): Promise<void> {
  const line = `${JSON.stringify(encoded)}\n`;
  if (!output.write(line, "utf8")) await once(output, "drain");
}

async function prepareLegacyDatabase(
  plan: BackupImportPlan,
  options: LocalBackupDatabasePreparationOptions,
): Promise<PreparedLocalBackupDatabase> {
  const databaseEntry = plan.legacyDatabase;
  if (!databaseEntry) {
    throw new Error("Legacy backup import plan is missing database.risudat");
  }

  const outputPath = `${databaseEntry.filePath}.sql.ndjson`;
  options.onProgress?.({
    current: 0,
    total: 0,
    detail: "Streaming legacy database",
  });

  try {
    const streamed = await streamLegacyBackupDatabaseToSqlNdjson(
      databaseEntry.filePath,
      {
        outputPath,
        encodeRecord: options.encodeRecord,
        idFactory: options.idFactory,
        sourceRevision: 0,
        onProgress(progress) {
          options.onProgress?.({
            current: progress.records,
            total: 0,
            detail: `Streaming legacy database · ${progress.phase}`,
          });
        },
      } satisfies StreamLegacyBackupOptions,
    );
    return {
      sourceRevision: streamed.sourceRevision,
      recordCount: streamed.recordCount,
      filePath: streamed.outputPath,
    };
  } catch (error) {
    if (!(error instanceof LegacyBackupStreamingUnsupportedError)) {
      await fs.rm(outputPath, { force: true }).catch(() => {});
      throw error;
    }
    await fs.rm(outputPath, { force: true }).catch(() => {});
  }

  options.onProgress?.({
    current: 0,
    total: 0,
    detail: "Decoding legacy compatibility format",
  });

  let database = decodeLegacyBackupDatabase(
    new Uint8Array(await fs.readFile(databaseEntry.filePath)),
  );
  if (!database || typeof database !== "object" || Array.isArray(database)) {
    throw new Error("Legacy backup database payload is invalid");
  }

  const output = createWriteStream(outputPath, {
    flags: "wx",
    mode: 0o600,
  });
  const outputDone = new Promise<void>((resolve, reject) => {
    output.once("finish", resolve);
    output.once("close", resolve);
    output.once("error", reject);
  });

  let recordCount = 0;
  try {
    for (const record of iterateLegacyBackupSqlRecords(
      database as Record<string, any>,
      {
        sourceRevision: 0,
        idFactory: options.idFactory,
      },
    )) {
      await writeRecordLine(output, options.encodeRecord(record));
      recordCount++;
      if (recordCount % 64 === 0) {
        options.onProgress?.({
          current: recordCount,
          total: 0,
          detail: "Converting legacy compatibility database",
        });
      }
    }
    output.end();
    await outputDone;
  } catch (error) {
    output.destroy();
    await Promise.allSettled([outputDone]);
    await fs.rm(outputPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    database = null;
  }

  return {
    sourceRevision: 0,
    recordCount,
    filePath: outputPath,
  };
}

async function prepareStreamDatabase(
  plan: BackupImportPlan,
  options: LocalBackupDatabasePreparationOptions,
): Promise<PreparedLocalBackupDatabase> {
  if (!plan.streamManifest) {
    throw new Error("Portable database stream manifest is missing");
  }

  const manifest = decodeManifest(
    decodeLegacyBackupDatabase(
      new Uint8Array(await fs.readFile(plan.streamManifest.filePath)),
    ),
  );
  if (manifest.totalFragments !== plan.streamFragments.length) {
    throw new Error(
      `Portable database stream fragment count mismatch; expected ${manifest.totalFragments}, got ${plan.streamFragments.length}`,
    );
  }

  const outputPath = `${plan.streamManifest.filePath}.sql.ndjson`;
  await fs.rm(outputPath, { force: true });
  const output = createWriteStream(outputPath, {
    flags: "wx",
    mode: 0o600,
  });
  const outputDone = new Promise<void>((resolve, reject) => {
    output.once("finish", resolve);
    output.once("close", resolve);
    output.once("error", reject);
  });
  const counts: Record<string, number> = {};
  let recordCount = 0;

  try {
    options.onProgress?.({
      current: 0,
      total: manifest.totalRecords,
      detail: "Preparing portable database stream",
    });

    for (
      let fragmentPosition = 0;
      fragmentPosition < plan.streamFragments.length;
      fragmentPosition++
    ) {
      const expectedIndex = fragmentPosition + 1;
      const entry = plan.streamFragments[fragmentPosition];
      const fragment = decodeFragment(
        decodeLegacyBackupDatabase(
          new Uint8Array(await fs.readFile(entry.filePath)),
        ),
        expectedIndex,
        entry.name,
      );

      for (const record of fragment.records) {
        if (
          !record ||
          typeof record !== "object" ||
          typeof record.type !== "string" ||
          !(LOCAL_BACKUP_DATABASE_RECORD_TYPES as readonly string[]).includes(
            record.type,
          )
        ) {
          throw new Error(
            `Portable database fragment ${entry.name} contains an unsupported record`,
          );
        }
        await writeRecordLine(output, options.encodeRecord(record));
        counts[record.type] = (counts[record.type] ?? 0) + 1;
        recordCount++;
      }

      options.onProgress?.({
        current: recordCount,
        total: manifest.totalRecords,
        detail: entry.name,
      });
    }

    if (recordCount !== manifest.totalRecords) {
      throw new Error(
        `Portable database stream record count mismatch; expected ${manifest.totalRecords}, got ${recordCount}`,
      );
    }
    for (const type of LOCAL_BACKUP_DATABASE_RECORD_TYPES) {
      if ((manifest.counts[type] ?? 0) !== (counts[type] ?? 0)) {
        throw new Error(
          `Portable database stream ${type} count does not match`,
        );
      }
    }
    for (const [type, count] of Object.entries(manifest.counts)) {
      if (
        !(LOCAL_BACKUP_DATABASE_RECORD_TYPES as readonly string[]).includes(
          type,
        ) &&
        Number(count) !== 0
      ) {
        throw new Error(
          `Portable database stream contains unsupported record type '${type}'`,
        );
      }
    }

    output.end();
    await outputDone;
  } catch (error) {
    output.destroy();
    await Promise.allSettled([outputDone]);
    await fs.rm(outputPath, { force: true }).catch(() => {});
    throw error;
  }

  return {
    sourceRevision: manifest.revision,
    recordCount,
    filePath: outputPath,
  };
}

export async function prepareLocalBackupDatabaseImport(
  plan: BackupImportPlan,
  options: LocalBackupDatabasePreparationOptions,
): Promise<PreparedLocalBackupDatabase> {
  return plan.databaseMode === "stream"
    ? await prepareStreamDatabase(plan, options)
    : await prepareLegacyDatabase(plan, options);
}
