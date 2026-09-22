import { describe, expect, it } from "vitest";
import { LocalBackupImportRecordStore } from "./localBackupImportRecords.js";

interface StoredRow {
  restoreId: string;
  sequence: number;
  tier: number;
  payload: string;
}

function selected(
  rows: StoredRow[],
  restoreId: string,
  lastTier: number,
  lastSequence: number,
): StoredRow[] {
  return rows
    .filter(
      (row) =>
        row.restoreId === restoreId &&
        (row.tier > lastTier ||
          (row.tier === lastTier && row.sequence > lastSequence)),
    )
    .sort(
      (left, right) => left.tier - right.tier || left.sequence - right.sequence,
    )
    .slice(0, 256);
}

function postgresStorage(rows: StoredRow[]) {
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes("INSERT INTO")) {
        const restoreId = String(values[0]);
        const parsed = JSON.parse(String(values[1])) as Array<{
          sequence_no: number;
          tier: number;
          payload: string;
        }>;
        rows.push(
          ...parsed.map((row) => ({
            restoreId,
            sequence: row.sequence_no,
            tier: row.tier,
            payload: row.payload,
          })),
        );
      } else if (sql.includes("SELECT sequence_no")) {
        return {
          rows: selected(
            rows,
            String(values[0]),
            Number(values[1]),
            Number(values[2]),
          ).map((row) => ({
            sequence_no: row.sequence,
            tier: row.tier,
            payload: row.payload,
          })),
        };
      } else if (sql.includes("DELETE FROM")) {
        const restoreId = String(values[0]);
        rows.splice(
          0,
          rows.length,
          ...rows.filter((row) => row.restoreId !== restoreId),
        );
      }
      return { rows: [] };
    },
  };
  return { pool };
}

function azureStorage(rows: StoredRow[]) {
  const pool = {
    request() {
      const inputs = new Map<string, unknown>();
      return {
        input(name: string, valueOrType: unknown, possibleValue?: unknown) {
          inputs.set(
            name,
            possibleValue === undefined ? valueOrType : possibleValue,
          );
          return this;
        },
        async query(sql: string) {
          if (sql.includes("INSERT INTO")) {
            const restoreId = String(inputs.get("restore_id"));
            const parsed = JSON.parse(String(inputs.get("rows"))) as Array<{
              sequence: number;
              tier: number;
              payload: string;
            }>;
            rows.push(...parsed.map((row) => ({ restoreId, ...row })));
          } else if (sql.includes("SELECT TOP")) {
            return {
              recordset: selected(
                rows,
                String(inputs.get("restore_id")),
                Number(inputs.get("last_tier")),
                Number(inputs.get("last_sequence")),
              ).map((row) => ({
                sequence_no: row.sequence,
                tier: row.tier,
                payload: row.payload,
              })),
            };
          } else if (sql.includes("DELETE FROM")) {
            const restoreId = String(inputs.get("restore_id"));
            rows.splice(
              0,
              rows.length,
              ...rows.filter((row) => row.restoreId !== restoreId),
            );
          }
          return { recordset: [] };
        },
      };
    },
  };
  return {
    async getPool() {
      return pool;
    },
  };
}

function oracleStorage(rows: StoredRow[]) {
  const connection = {
    async execute(sql: string, binds: unknown[] = []) {
      if (sql.includes("SELECT sequence_no")) {
        return {
          rows: selected(
            rows,
            String(binds[0]),
            Number(binds[1]),
            Number(binds[2]),
          ).map((row) => [row.sequence, row.tier, row.payload]),
        };
      }
      if (sql.includes("DELETE FROM")) {
        const restoreId = String(binds[0]);
        rows.splice(
          0,
          rows.length,
          ...rows.filter((row) => row.restoreId !== restoreId),
        );
      }
      return { rows: [] };
    },
    async executeMany(_sql: string, binds: Array<Record<string, unknown>>) {
      rows.push(
        ...binds.map((row) => ({
          restoreId: String(row.restore_id),
          sequence: Number(row.sequence_no),
          tier: Number(row.tier),
          payload: String(row.payload),
        })),
      );
    },
    async commit() {},
    async rollback() {},
    async close() {},
  };
  return {
    pool: {
      async getConnection() {
        return connection;
      },
    },
  };
}

const adapter = {
  encodeRecord(record: Record<string, unknown>) {
    return record;
  },
  decodeRecord(value: unknown) {
    return value as { type: string; [key: string]: unknown };
  },
  validateRecord(
    record: { type: string; [key: string]: unknown },
    index: number,
    state: { sourceRevision: number | null; entityPhase: boolean },
  ) {
    if (index === 0) {
      expect(record.type).toBe("meta");
      state.sourceRevision = Number(record.revision);
      return;
    }
    if (["character", "chat", "message"].includes(record.type)) {
      state.entityPhase = true;
    } else if (state.entityPhase) {
      throw new Error("root record followed an entity record");
    }
  },
};

describe.each(["postgres", "azure", "oracle"] as const)(
  "LocalBackupImportRecordStore (%s)",
  (vendor) => {
    it("stages records in SQL and replays cold storage before entities", async () => {
      const rows: StoredRow[] = [];
      const storage =
        vendor === "postgres"
          ? postgresStorage(rows)
          : vendor === "azure"
            ? azureStorage(rows)
            : oracleStorage(rows);
      const store = new LocalBackupImportRecordStore(
        () => storage,
        () => vendor,
        adapter,
      );
      const id = `restore_${vendor}`;
      let sequence = await store.append(id, 0, [
        { type: "meta", formatVersion: 1, revision: 12 },
        { type: "character", id: "char-1", position: 0, data: {} },
      ]);
      sequence = await store.append(id, sequence, [
        { type: "cold-storage", key: "cold-1", value: {} },
      ]);
      expect(sequence).toBe(3);

      const seen: string[] = [];
      const dynamicStorage = storage as unknown as {
        pool?: { getConnection?: () => Promise<unknown> };
        getPool?: () => Promise<unknown>;
      };
      const client =
        vendor === "azure"
          ? await dynamicStorage.getPool!()
          : vendor === "oracle"
            ? await dynamicStorage.pool!.getConnection!()
            : dynamicStorage.pool;
      const staging = store.createSqlStaging(id, client, 3, 12);
      await expect(
        staging.validate(
          {},
          {
            async onRecord(record) {
              seen.push(record.type);
            },
          },
        ),
      ).resolves.toMatchObject({ recordCount: 3, sourceRevision: 12 });
      expect(seen).toEqual(["meta", "cold-storage", "character"]);

      await store.cleanup(id);
      expect(rows).toEqual([]);
    });
  },
);
