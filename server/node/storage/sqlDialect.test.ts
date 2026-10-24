"use strict";

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PostgresDialect } from "./postgres/postgresDialect.ts";
import { AzureDialect } from "./azure/azureDialect.ts";
import {
  OracleDialect,
  oracleColumnName,
  oracleTableName,
} from "./oracle/oracleDialect.ts";
import { SNAPSHOT_TABLES, sqlTableSpecs } from "./sqlTables.ts";

/** Records every statement a dialect emits, for both SQL and bind assertions. */
type Recorded = { sql: string; params?: readonly unknown[] };

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function makePostgres() {
  const calls: Recorded[] = [];
  const client = {
    async query(sql: string, params?: readonly unknown[]) {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
  return { dialect: new PostgresDialect(client), calls };
}

function makeAzure() {
  const calls: Recorded[] = [];
  const request = () => {
    const params: unknown[] = [];
    return {
      input(name: string, _type: unknown, value: unknown) {
        params.push({ name, value } as unknown);
        return this;
      },
      async query(sql: string) {
        calls.push({ sql, params });
        return { recordset: [] };
      },
    };
  };
  const target = { request } as unknown as ConstructorParameters<
    typeof AzureDialect
  >[0];
  return { dialect: new AzureDialect(target), calls };
}

function makeOracle() {
  const calls: (Recorded & { options?: unknown })[] = [];
  const connection = {
    async execute(sql: string, params?: unknown, options?: unknown) {
      calls.push({ sql, params: params as readonly unknown[], options });
      return { rows: [] };
    },
    async executeMany(
      sql: string,
      params: readonly unknown[],
      options?: unknown,
    ) {
      calls.push({ sql, params, options });
      return { rowsAffected: 0 };
    },
  };
  return { dialect: new OracleDialect(connection), calls };
}

const MESSAGE = {
  chat_id: "chat-1",
  id: "msg-1",
  position: 0,
  role: "char",
  content_text: "hello",
  content_binary: null,
  saying_character_id: null,
  sent_time: 1700000000000,
  sender_name: "",
  other_user: false,
  disabled_scope: "none",
  is_comment: true,
};

describe("PostgreSQL dialect", () => {
  it("inserts through UNNEST with neutral types cast per column", async () => {
    const { dialect, calls } = makePostgres();
    await dialect.insertRows("chat.messages", [MESSAGE]);

    expect(normalize(calls[0].sql)).toContain(
      'INSERT INTO "chat"."messages" ("chat_id", "id", "position", "role", "content_text", "content_binary", "saying_character_id", "sent_time", "sender_name", "other_user", "disabled_scope", "is_comment")',
    );
    expect(normalize(calls[0].sql)).toContain(
      "SELECT * FROM UNNEST($1::text[], $2::text[], $3::integer[], $4::text[], $5::text[], $6::bytea[], $7::text[], $8::bigint[], $9::text[], $10::boolean[], $11::text[], $12::boolean[])",
    );
    expect(calls[0].params).toHaveLength(12);
  });

  it("serializes json columns to text before binding", async () => {
    const { dialect, calls } = makePostgres();
    await dialect.insertRows("chat.message_prompt_items", [
      { chat_id: "c", message_id: "m", position: 0, payload: { a: 1 } },
    ]);
    expect(calls[0].params?.[3]).toEqual(['{"a":1}']);
  });

  it("adds ON CONFLICT and the updated_at touch on upsert", async () => {
    const { dialect, calls } = makePostgres();
    await dialect.upsertRows("chat.messages", [MESSAGE]);
    const sql = normalize(calls[0].sql);
    expect(sql).toContain(
      'ON CONFLICT ("chat_id", "id") DO UPDATE SET "position" = EXCLUDED."position"',
    );
    expect(sql).toContain('"updated_at" = NOW()');
    expect(sql).toContain("IS DISTINCT FROM");
  });

  it("deletes key tuples with a USING UNNEST join", async () => {
    const { dialect, calls } = makePostgres();
    await dialect.deleteByKeys(
      "chat.message_attributes",
      ["chat_id", "message_id"],
      [["chat-1", "msg-1"]],
    );
    const sql = normalize(calls[0].sql);
    expect(sql).toContain(
      'DELETE FROM "chat"."message_attributes" AS target USING UNNEST($1::text[], $2::text[]) AS spec("chat_id", "message_id")',
    );
    expect(sql).toContain(
      'target."chat_id" = spec."chat_id" AND target."message_id" = spec."message_id"',
    );
  });

  it("prunes rows past the declared length", async () => {
    const { dialect, calls } = makePostgres();
    await dialect.prunePositions("character.tags", "character_id", [
      { ownerId: "char-1", length: 2 },
    ]);
    const sql = normalize(calls[0].sql);
    expect(sql).toContain(
      'DELETE FROM "character"."tags" AS target USING UNNEST($1::text[], $2::integer[]) AS spec(owner_id, target_len)',
    );
    expect(sql).toContain('target."position" >= spec.target_len');
  });

  it("selects in spec order and applies the snapshot exclusion", async () => {
    const { dialect, calls } = makePostgres();
    await dialect.selectOrdered("system.settings");
    expect(normalize(calls[0].sql)).toBe(
      "SELECT * FROM \"system\".\"settings\" WHERE \"key\" NOT IN ('username', 'userIcon', 'userNote', 'personaPrompt') ORDER BY \"key\"",
    );
  });
});

describe("Azure SQL dialect", () => {
  it("inserts through OPENJSON with a typed WITH clause", async () => {
    const { dialect, calls } = makeAzure();
    await dialect.insertRows("chat.messages", [MESSAGE]);
    const sql = normalize(calls[0].sql);
    expect(sql).toContain(
      "INSERT INTO [chat].[messages] ([chat_id], [id], [position], [role], [content_text], [content_binary], [saying_character_id], [sent_time], [sender_name], [other_user], [disabled_scope], [is_comment])",
    );
    expect(sql).toContain("[chat_id] NVARCHAR(MAX) '$.chat_id'");
    expect(sql).toContain("[position] INT '$.position'");
    expect(sql).toContain("[sent_time] BIGINT '$.sent_time'");
    expect(sql).toContain("[is_comment] BIT '$.is_comment'");
    expect(sql).toContain("[content_text] NVARCHAR(MAX) '$.content_text'");
    expect(sql).toContain(
      "CASE WHEN [content_binary] IS NOT NULL THEN CONVERT(VARBINARY(MAX), [content_binary], 2) ELSE NULL END AS [content_binary]",
    );
  });

  it("turns booleans into bits and buffers into hex in the payload", async () => {
    const { dialect, calls } = makeAzure();
    await dialect.insertRows("chat.messages", [
      { ...MESSAGE, is_comment: true, content_binary: Buffer.from("ab") },
    ]);
    const payload = JSON.parse(
      String((calls[0].params?.[0] as { value: unknown }).value),
    )[0];
    expect(payload.is_comment).toBe(1);
    expect(payload.content_binary).toBe("6162");
  });

  it("upserts with MERGE on the spec key", async () => {
    const { dialect, calls } = makeAzure();
    await dialect.upsertRows("chat.messages", [MESSAGE]);
    const sql = normalize(calls[0].sql);
    expect(sql).toContain("MERGE INTO [chat].[messages] AS target");
    expect(sql).toContain(
      "ON target.[chat_id] = source.[chat_id] AND target.[id] = source.[id]",
    );
    expect(sql).toContain("WHEN NOT MATCHED THEN INSERT");
  });

  it("inserts instead of merging when the table has no key", async () => {
    const { dialect, calls } = makeAzure();
    await dialect.upsertRows("chat.message_prompt_toggles", [
      {
        chat_id: "c",
        message_id: "m",
        position: 0,
        toggle_key: "k",
        toggle_value: "v",
      },
    ]);
    expect(normalize(calls[0].sql)).not.toContain("MERGE");
  });

  it("deletes key tuples through OPENJSON", async () => {
    const { dialect, calls } = makeAzure();
    await dialect.deleteByKeys(
      "chat.message_attributes",
      ["chat_id", "message_id"],
      [["chat-1", "msg-1"]],
    );
    const sql = normalize(calls[0].sql);
    expect(sql).toContain(
      "DELETE targetRows FROM [chat].[message_attributes] targetRows INNER JOIN OPENJSON(@keyPayload)",
    );
    expect(sql).toContain(
      "targetRows.[chat_id] = src.[chat_id] AND targetRows.[message_id] = src.[message_id]",
    );
  });

  it("selects in spec order without an exclusion when none is declared", async () => {
    const { dialect, calls } = makeAzure();
    await dialect.selectOrdered("chat.messages");
    expect(normalize(calls[0].sql)).toBe(
      "SELECT * FROM [chat].[messages] ORDER BY [chat_id], [position], [id]",
    );
  });
});

describe("Oracle dialect", () => {
  it("maps logical table and column names to Oracle physical names", async () => {
    const { dialect, calls } = makeOracle();
    await dialect.insertRows("chat.message_attributes", [
      { chat_id: "c", message_id: "m", key: "k", value: { a: 1 } },
    ]);
    const sql = normalize(calls[0].sql);
    // flat table name, KEY → KEY_VALUE, and JSON() for json columns
    expect(sql).toContain(
      "INSERT INTO chat_message_attributes (CHAT_ID, MESSAGE_ID, KEY_VALUE, VALUE)",
    );
    expect(sql).toContain("VALUES (:1, :2, :3, JSON(:4))");
  });

  it("orders LOB columns last so ORA-24816 cannot trigger", async () => {
    const { dialect, calls } = makeOracle();
    await dialect.insertRows("chat.messages", [MESSAGE]);
    const sql = normalize(calls[0].sql);
    const columnsPart = sql.slice(
      sql.indexOf("(") + 1,
      sql.indexOf(") VALUES"),
    );
    const columns = columnsPart.split(", ").map((entry) => entry.trim());
    const lobColumns = ["CONTENT_TEXT", "CONTENT_BINARY"];
    expect(columns.slice(-2)).toEqual(lobColumns);
    expect(columns).toContain("SENDER_NAME");
  });

  it("upserts with an update-then-insert block bound by name", async () => {
    const { dialect, calls } = makeOracle();
    await dialect.upsertRows("chat.messages", [MESSAGE]);
    const sql = normalize(calls[0].sql);
    expect(sql).toContain("BEGIN UPDATE chat_messages SET");
    expect(sql).toContain("WHERE CHAT_ID = :chat_id AND ID = :id;");
    expect(sql).toContain("updated_at = SYSTIMESTAMP");
    expect(sql).toContain("IF SQL%ROWCOUNT = 0 THEN INSERT INTO chat_messages");
    expect(calls[0].params?.[0]).toMatchObject({ chat_id: "chat-1" });
  });

  it("deletes key tuples with executeMany positional binds", async () => {
    const { dialect, calls } = makeOracle();
    await dialect.deleteByKeys(
      "chat.message_attributes",
      ["chat_id", "message_id"],
      [["chat-1", "msg-1"]],
    );
    expect(normalize(calls[0].sql)).toBe(
      "DELETE FROM chat_message_attributes WHERE CHAT_ID = :1 AND MESSAGE_ID = :2",
    );
    expect(calls[0].params).toEqual([["chat-1", "msg-1"]]);
  });

  it("selects with upper-cased order columns and the snapshot exclusion", async () => {
    const { dialect, calls } = makeOracle();
    await dialect.selectOrdered("system.settings");
    expect(normalize(calls[0].sql)).toBe(
      "SELECT * FROM system_settings WHERE KEY NOT IN ('username', 'userIcon', 'userNote', 'personaPrompt') ORDER BY KEY",
    );
  });
});

describe("table spec conformance", () => {
  const schemaRoot = resolve(import.meta.dirname);

  /** Crude but sufficient parser: table → column → physical type. */
  function parseSchema(file: string, kind: "pg" | "azure" | "oracle") {
    const text = readFileSync(resolve(schemaRoot, file), "utf8");
    const tables = new Map<string, Map<string, string>>();
    let current: string | null = null;
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      const create = /^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(.+?)\s*\($/i.exec(
        line,
      );
      if (create) {
        const name = create[1]
          .replace(/[[\]"]/g, "")
          .replace(/\s+/g, "")
          .toLowerCase();
        current = name;
        tables.set(current, new Map());
        continue;
      }
      if (current && line.startsWith(")")) {
        current = null;
        continue;
      }
      if (!current) continue;
      const column =
        /^(?:[[\]"]?([A-Za-z_][A-Za-z0-9_]*)[\]"]?)\s+([A-Za-z][A-Za-z0-9_ ()']*)/.exec(
          line,
        );
      if (!column) continue;
      const name = column[1].toLowerCase();
      const physicalType = column[2]
        .toLowerCase()
        .replace(
          /\s+(not|null|check|default|primary|references|unique|generated|collate).*$/,
          "",
        )
        .trim();
      if (
        [
          "primary",
          "unique",
          "constraint",
          "foreign",
          "index",
          "check",
          "on",
          "deferrable",
          "references",
        ].includes(name)
      ) {
        continue;
      }
      tables.get(current)?.set(name, physicalType);
    }
    return tables;
  }

  const schemas = {
    postgres: parseSchema("postgres/postgres-schema.sql", "pg"),
    azure: parseSchema("azure/azure-schema.sql", "azure"),
    oracle: parseSchema("oracle/oracle-schema.sql", "oracle"),
  };

  // The dialect owns the Oracle naming tables, so the conformance check also
  // verifies that those tables still match the real schema files.
  const oracleName = oracleTableName;

  it("declares every spec table in all three schemas", () => {
    for (const spec of sqlTableSpecs()) {
      expect(
        schemas.postgres.has(spec.name),
        `postgres schema is missing ${spec.name}`,
      ).toBe(true);
      expect(
        schemas.azure.has(spec.name),
        `azure schema is missing ${spec.name}`,
      ).toBe(true);
      expect(
        schemas.oracle.has(oracleName(spec.name)),
        `oracle schema is missing ${oracleName(spec.name)}`,
      ).toBe(true);
    }
  });

  it("declares write and order columns that exist in every schema", () => {
    for (const spec of sqlTableSpecs()) {
      const oracleTable = oracleName(spec.name);
      const columns = [
        ...(spec.columns ?? []).map(([column]) => column),
        ...spec.orderBy,
        ...(spec.excludeOnSnapshot ? [spec.excludeOnSnapshot.column] : []),
        ...(spec.key ?? []),
      ];
      for (const column of columns) {
        expect(
          schemas.postgres.get(spec.name)?.has(column),
          `postgres ${spec.name} has no column ${column}`,
        ).toBe(true);
        expect(
          schemas.azure.get(spec.name)?.has(column),
          `azure ${spec.name} has no column ${column}`,
        ).toBe(true);
        const physical = oracleColumnName(spec.name, column).toLowerCase();
        expect(
          schemas.oracle.get(oracleTable)?.has(physical),
          `oracle ${oracleTable} has no column ${physical}`,
        ).toBe(true);
      }
    }
  });

  /**
   * Neutral type → the physical types each vendor's schema is allowed to use.
   * This is what makes the spec trustworthy: a column whose real type disagrees
   * with the neutral one would bind wrongly (CLOB vs VARCHAR2, BIT vs INT).
   */
  const ALLOWED_TYPES: Record<
    "postgres" | "azure" | "oracle",
    Record<string, readonly string[]>
  > = {
    postgres: {
      text: ["text"],
      key: ["text"],
      int: ["integer"],
      bigint: ["bigint"],
      float: ["double precision"],
      bool: ["boolean"],
      json: ["jsonb"],
      binary: ["bytea"],
      timestamp: ["timestamp with time zone", "timestamp"],
    },
    azure: {
      text: ["nvarchar(max)"],
      key: [
        "nvarchar(max)",
        "nvarchar(450)",
        "nvarchar(512)",
        "nvarchar(32)",
        "nvarchar(16)",
        "nvarchar(128)",
      ],
      int: ["int"],
      bigint: ["bigint"],
      float: ["float"],
      bool: ["bit"],
      json: ["nvarchar(max)"],
      binary: ["varbinary(max)"],
      timestamp: ["datetimeoffset"],
    },
    oracle: {
      text: ["clob"],
      key: ["varchar2(4000)", "varchar2(512)", "varchar2(32)", "varchar2(16)"],
      int: ["integer", "number"],
      bigint: ["number", "integer"],
      float: ["binary_double", "number"],
      bool: ["number(1)"],
      json: ["json", "clob"],
      binary: ["blob"],
      timestamp: ["timestamp with time zone", "timestamp"],
    },
  };

  it("declares neutral types that every schema agrees with", () => {
    const disagreements: string[] = [];
    for (const spec of sqlTableSpecs()) {
      const oracleTable = oracleName(spec.name);
      for (const [column, type] of spec.columns ?? []) {
        const physical = oracleColumnName(spec.name, column).toLowerCase();
        const observed = {
          postgres: schemas.postgres.get(spec.name)?.get(column),
          azure: schemas.azure.get(spec.name)?.get(column),
          oracle: schemas.oracle.get(oracleTable)?.get(physical),
        };
        for (const vendor of ["postgres", "azure", "oracle"] as const) {
          const actual = observed[vendor];
          if (!actual) continue;
          if (!ALLOWED_TYPES[vendor][type]?.includes(actual)) {
            disagreements.push(
              `${spec.name}.${column} declared ${type}, ${vendor} stores ${actual}`,
            );
          }
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("lists only tables it also declares in the snapshot order", () => {
    const declared = new Set(sqlTableSpecs().map((spec) => spec.name));
    expect(SNAPSHOT_TABLES.filter((name) => !declared.has(name))).toEqual([]);
    expect(new Set(SNAPSHOT_TABLES).size).toBe(SNAPSHOT_TABLES.length);
  });
});
