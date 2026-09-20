import { once } from "node:events";
import { createWriteStream, promises as fs } from "node:fs";
import { LOCAL_BACKUP_DATABASE_RECORD_TYPES } from "./databaseStreamStore";
import { decodeLegacyBackupDatabase } from "./legacyFormat";
import {
  LegacyBackupStreamingUnsupportedError,
  streamLegacyBackupDatabaseToSqlNdjson,
  type StreamLegacyBackupOptions,
} from "./legacyStream";
import {
  iterateLegacyBackupSqlRecords,
  type LegacyBackupSqlRecord,
} from "../legacyRecords";
import { LEGACY_DATABASE_ENTRY_NAME } from "../entryPolicy";
import {
  parsePortableDatabaseStreamFragment,
  parsePortableDatabaseStreamManifest,
  type PortableDatabaseStreamFragment,
  type PortableDatabaseStreamManifest,
} from "../streamFormat";
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
  onProgress?: (progress: LocalBackupDatabasePreparationProgress) => void;
}

function requireObject(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, any>;
}

function decodeManifest(data: unknown): PortableDatabaseStreamManifest {
  const manifest = requireObject(data, "Portable database stream manifest");
  const parsed: PortableDatabaseStreamManifest | null =
    parsePortableDatabaseStreamManifest(manifest);
  if (!parsed || Array.isArray(parsed.counts)) {
    throw new Error("Portable database stream manifest is invalid");
  }
  return parsed;
}

function decodeFragment(
  data: unknown,
  expectedIndex: number,
  name: string,
): PortableDatabaseStreamFragment {
  const fragment = requireObject(data, `Portable database fragment ${name}`);
  const parsed: PortableDatabaseStreamFragment | null =
    parsePortableDatabaseStreamFragment(fragment, {
      expectedIndex,
    });
  if (!parsed) {
    throw new Error(`Invalid portable database fragment: ${name}`);
  }
  return parsed;
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
    throw new Error(
      `Legacy backup import plan is missing ${LEGACY_DATABASE_ENTRY_NAME}`,
    );
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
