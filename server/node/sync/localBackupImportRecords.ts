type SqlVendor = "postgres" | "oracle" | "azure";

type QueryResult = { rows?: Array<Record<string, unknown>> };
type PostgresClient = {
  query(sql: string, values?: unknown[]): Promise<QueryResult>;
  release?(): void;
};
type AzureRequest = {
  input(name: string, value: unknown): AzureRequest;
  input(name: string, type: unknown, value: unknown): AzureRequest;
  query(sql: string): Promise<{ recordset?: Array<Record<string, unknown>> }>;
};
type AzureClient = { request(): AzureRequest };
type OracleResult = { rows?: unknown[][] };
type OracleClient = {
  execute(
    sql: string,
    binds?: unknown[] | Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<OracleResult>;
  executeMany?(
    sql: string,
    binds: Array<Record<string, unknown>>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
  close?(): Promise<void>;
};

type SqlRestoreStorage = {
  pool?: {
    query?(sql: string, values?: unknown[]): Promise<QueryResult>;
    connect?(): Promise<PostgresClient>;
    getConnection?(): Promise<OracleClient>;
  };
  getPool?(): Promise<AzureClient>;
};

type RestoreRecord = { type: string; [key: string]: unknown };
type RestoreRecordAdapter = {
  encodeRecord(record: RestoreRecord): unknown;
  decodeRecord(value: unknown): RestoreRecord;
  validateRecord(
    record: RestoreRecord,
    index: number,
    state: { sourceRevision: number | null; entityPhase: boolean },
  ): void;
};

type StoredRow = {
  sequence: number;
  tier: number;
  payload: string;
};

export interface LocalBackupSqlStaging {
  validate(
    session: unknown,
    options?: {
      onRecord?: (record: RestoreRecord, index: number) => Promise<void>;
    },
  ): Promise<{
    recordCount: number;
    sourceRevision: number | null;
    counts: Record<string, number>;
  }>;
}

const PAGE_SIZE = 256;

function validateRestoreId(id: string): string {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
    throw new Error("Invalid local backup restore id");
  }
  return id;
}

function recordTier(record: RestoreRecord): number {
  if (record.type === "meta") return 0;
  if (
    ["setting", "plugin-storage", "module", "preset", "cold-storage"].includes(
      record.type,
    )
  ) {
    return 1;
  }
  return 2;
}

export class LocalBackupImportRecordStore {
  private schemaReady: Promise<void> | null = null;
  private schemaStorage: SqlRestoreStorage | null = null;
  private schemaVendor: SqlVendor | null = null;

  constructor(
    private readonly getStorage: () => SqlRestoreStorage,
    private readonly getVendor: () => SqlVendor,
    private readonly adapter: RestoreRecordAdapter,
  ) {}

  private async postgresPool(): Promise<PostgresClient> {
    const pool = this.getStorage().pool;
    if (!pool?.query)
      throw new Error("PostgreSQL restore staging is unavailable");
    return pool as PostgresClient;
  }

  private async azurePool(): Promise<AzureClient> {
    const factory = this.getStorage().getPool;
    if (!factory) throw new Error("Azure SQL restore staging is unavailable");
    return await factory.call(this.getStorage());
  }

  private async oracleConnection(): Promise<OracleClient> {
    const factory = this.getStorage().pool?.getConnection;
    if (!factory) throw new Error("Oracle restore staging is unavailable");
    return await factory.call(this.getStorage().pool);
  }

  private async ensureSchema(): Promise<void> {
    const storage = this.getStorage();
    const vendor = this.getVendor();
    if (this.schemaStorage !== storage || this.schemaVendor !== vendor) {
      this.schemaReady = null;
      this.schemaStorage = storage;
      this.schemaVendor = vendor;
    }
    if (!this.schemaReady) {
      this.schemaReady = this.createSchema().catch((error) => {
        this.schemaReady = null;
        throw error;
      });
    }
    await this.schemaReady;
  }

  private async createSchema(): Promise<void> {
    const vendor = this.getVendor();
    if (vendor === "postgres") {
      const pool = await this.postgresPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS system.local_backup_import_records (
          restore_id VARCHAR(128) NOT NULL,
          sequence_no BIGINT NOT NULL,
          tier SMALLINT NOT NULL,
          payload JSONB NOT NULL,
          PRIMARY KEY (restore_id, sequence_no)
        )
      `);
      return;
    }
    if (vendor === "azure") {
      const pool = await this.azurePool();
      await pool.request().query(`
        IF OBJECT_ID(N'[system].[local_backup_import_records]', N'U') IS NULL
        BEGIN
          CREATE TABLE [system].[local_backup_import_records] (
            restore_id NVARCHAR(128) NOT NULL,
            sequence_no BIGINT NOT NULL,
            tier INT NOT NULL,
            payload NVARCHAR(MAX) NOT NULL,
            CONSTRAINT PK_local_backup_import_records
              PRIMARY KEY (restore_id, sequence_no)
          );
        END
      `);
      return;
    }
    const connection = await this.oracleConnection();
    try {
      await connection.execute(`
        CREATE TABLE system_local_backup_import_records (
          restore_id VARCHAR2(128) NOT NULL,
          sequence_no NUMBER(19) NOT NULL,
          tier NUMBER(2) NOT NULL,
          payload CLOB NOT NULL,
          CONSTRAINT local_backup_import_records_pk
            PRIMARY KEY (restore_id, sequence_no)
        )
      `);
      await connection.commit?.();
    } catch (error) {
      if ((error as { errorNum?: number } | null)?.errorNum !== 955)
        throw error;
    } finally {
      await connection.close?.();
    }
  }

  async append(
    id: string,
    sequence: number,
    records: readonly RestoreRecord[],
  ): Promise<number> {
    validateRestoreId(id);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error("Invalid restore record sequence");
    }
    if (records.length === 0) return sequence;
    await this.ensureSchema();
    const rows: StoredRow[] = records.map((record, index) => ({
      sequence: sequence + index,
      tier: recordTier(record),
      payload: JSON.stringify(this.adapter.encodeRecord(record)),
    }));
    const vendor = this.getVendor();
    if (vendor === "postgres") {
      const pool = await this.postgresPool();
      await pool.query(
        `INSERT INTO system.local_backup_import_records
           (restore_id, sequence_no, tier, payload)
         SELECT $1, row.sequence_no, row.tier, row.payload::jsonb
           FROM jsonb_to_recordset($2::jsonb)
             AS row(sequence_no bigint, tier smallint, payload text)`,
        [
          id,
          JSON.stringify(
            rows.map((row) => ({
              sequence_no: row.sequence,
              tier: row.tier,
              payload: row.payload,
            })),
          ),
        ],
      );
      return sequence + rows.length;
    }
    if (vendor === "azure") {
      const sql = require("mssql");
      const pool = await this.azurePool();
      const request = pool.request();
      request.input("restore_id", sql.NVarChar(128), id);
      request.input("rows", sql.NVarChar(sql.MAX), JSON.stringify(rows));
      await request.query(`
        INSERT INTO [system].[local_backup_import_records]
          (restore_id, sequence_no, tier, payload)
        SELECT @restore_id, sequence_no, tier, payload
          FROM OPENJSON(@rows)
          WITH (
            sequence_no BIGINT '$.sequence',
            tier INT '$.tier',
            payload NVARCHAR(MAX) '$.payload'
          )
      `);
      return sequence + rows.length;
    }
    const connection = await this.oracleConnection();
    try {
      if (!connection.executeMany) {
        throw new Error("Oracle batch restore staging is unavailable");
      }
      await connection.executeMany(
        `INSERT INTO system_local_backup_import_records
           (restore_id, sequence_no, tier, payload)
         VALUES (:restore_id, :sequence_no, :tier, :payload)`,
        rows.map((row) => ({
          restore_id: id,
          sequence_no: row.sequence,
          tier: row.tier,
          payload: row.payload,
        })),
        {
          bindDefs: {
            restore_id: {
              type: require("oracledb").DB_TYPE_VARCHAR,
              maxSize: 128,
            },
            sequence_no: { type: require("oracledb").DB_TYPE_NUMBER },
            tier: { type: require("oracledb").DB_TYPE_NUMBER },
            payload: { type: require("oracledb").DB_TYPE_CLOB },
          },
        },
      );
      await connection.commit?.();
      return sequence + rows.length;
    } catch (error) {
      await connection.rollback?.().catch(() => {});
      throw error;
    } finally {
      await connection.close?.();
    }
  }

  private async readPage(
    client: PostgresClient | AzureClient | OracleClient,
    id: string,
    lastTier: number,
    lastSequence: number,
  ): Promise<StoredRow[]> {
    const vendor = this.getVendor();
    if (vendor === "postgres") {
      const result = await (client as PostgresClient).query(
        `SELECT sequence_no, tier, payload::text AS payload
           FROM system.local_backup_import_records
          WHERE restore_id = $1
            AND (tier > $2 OR (tier = $2 AND sequence_no > $3))
          ORDER BY tier, sequence_no
          LIMIT $4`,
        [id, lastTier, lastSequence, PAGE_SIZE],
      );
      return (result.rows ?? []).map((row) => ({
        sequence: Number(row.sequence_no),
        tier: Number(row.tier),
        payload: String(row.payload),
      }));
    }
    if (vendor === "azure") {
      const sql = require("mssql");
      const request = (client as AzureClient).request();
      request.input("restore_id", sql.NVarChar(128), id);
      request.input("last_tier", sql.Int, lastTier);
      request.input("last_sequence", sql.BigInt, lastSequence);
      request.input("page_size", sql.Int, PAGE_SIZE);
      const result = await request.query(`
        SELECT TOP (@page_size) sequence_no, tier, payload
          FROM [system].[local_backup_import_records]
         WHERE restore_id = @restore_id
           AND (tier > @last_tier OR
                (tier = @last_tier AND sequence_no > @last_sequence))
         ORDER BY tier, sequence_no
      `);
      return (result.recordset ?? []).map((row) => ({
        sequence: Number(row.sequence_no),
        tier: Number(row.tier),
        payload: String(row.payload),
      }));
    }
    const result = await (client as OracleClient).execute(
      `SELECT sequence_no, tier, payload
         FROM system_local_backup_import_records
        WHERE restore_id = :1
          AND (tier > :2 OR (tier = :2 AND sequence_no > :3))
        ORDER BY tier, sequence_no
        FETCH FIRST ${PAGE_SIZE} ROWS ONLY`,
      [id, lastTier, lastSequence],
      { outFormat: require("oracledb").OUT_FORMAT_ARRAY },
    );
    return (result.rows ?? []).map((row) => ({
      sequence: Number(row[0]),
      tier: Number(row[1]),
      payload: String(row[2]),
    }));
  }

  createSqlStaging(
    id: string,
    client: PostgresClient | AzureClient | OracleClient,
    expectedRecordCount: number,
    expectedSourceRevision: number,
  ): LocalBackupSqlStaging {
    validateRestoreId(id);
    return {
      validate: async (_session, options = {}) => {
        const state = { sourceRevision: null, entityPhase: false } as {
          sourceRevision: number | null;
          entityPhase: boolean;
        };
        const counts: Record<string, number> = {};
        let recordCount = 0;
        let lastTier = -1;
        let lastSequence = -1;
        while (true) {
          const rows = await this.readPage(client, id, lastTier, lastSequence);
          if (rows.length === 0) break;
          for (const row of rows) {
            const encoded: unknown = JSON.parse(row.payload);
            const record = this.adapter.decodeRecord(encoded);
            this.adapter.validateRecord(record, recordCount, state);
            counts[record.type] = (counts[record.type] ?? 0) + 1;
            await options.onRecord?.(record, recordCount);
            recordCount++;
            lastTier = row.tier;
            lastSequence = row.sequence;
          }
        }
        if (recordCount !== expectedRecordCount) {
          throw new Error(
            `Restore record count mismatch: expected ${expectedRecordCount}, got ${recordCount}`,
          );
        }
        if (state.sourceRevision !== expectedSourceRevision) {
          throw new Error(
            `Restore source revision mismatch: expected ${expectedSourceRevision}, got ${String(state.sourceRevision)}`,
          );
        }
        return { recordCount, sourceRevision: state.sourceRevision, counts };
      },
    };
  }

  async cleanup(id: string): Promise<void> {
    validateRestoreId(id);
    await this.ensureSchema();
    const vendor = this.getVendor();
    if (vendor === "postgres") {
      const pool = await this.postgresPool();
      await pool.query(
        "DELETE FROM system.local_backup_import_records WHERE restore_id = $1",
        [id],
      );
      return;
    }
    if (vendor === "azure") {
      const sql = require("mssql");
      const pool = await this.azurePool();
      const request = pool.request();
      request.input("restore_id", sql.NVarChar(128), id);
      await request.query(
        "DELETE FROM [system].[local_backup_import_records] WHERE restore_id = @restore_id",
      );
      return;
    }
    const connection = await this.oracleConnection();
    try {
      await connection.execute(
        "DELETE FROM system_local_backup_import_records WHERE restore_id = :1",
        [id],
      );
      await connection.commit?.();
    } finally {
      await connection.close?.();
    }
  }

  async cleanupAll(): Promise<void> {
    await this.ensureSchema();
    const vendor = this.getVendor();
    if (vendor === "postgres") {
      const pool = await this.postgresPool();
      await pool.query("DELETE FROM system.local_backup_import_records");
      return;
    }
    if (vendor === "azure") {
      const pool = await this.azurePool();
      await pool
        .request()
        .query("DELETE FROM [system].[local_backup_import_records]");
      return;
    }
    const connection = await this.oracleConnection();
    try {
      await connection.execute(
        "DELETE FROM system_local_backup_import_records",
      );
      await connection.commit?.();
    } finally {
      await connection.close?.();
    }
  }
}
