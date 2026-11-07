import { encodeJsonValue } from "./jsonCodec.ts";
import {
  Character,
  validateCharacterKeys,
  validateCharacterUpdate,
  type CharacterFields,
  type CharacterUpdate,
} from "../../../../packages/protocol/domain/character.ts";
import {
  CHARACTER_FIELD_COLUMNS,
  CHARACTER_RELATIONS,
  decodeCharacterReadRow,
  type CharacterReadRow,
} from "./relationalCodec.ts";
import type { ISqlStorage } from "../../../../packages/storage-core/src/sqlStorage.ts";
import {
  Kysely,
  PostgresDialect as KyselyPostgresDialect,
  sql,
  Transaction,
  type ExpressionBuilder,
  type PostgresPool,
} from "kysely";
import { Pool } from "pg";
import { characterPatch } from "./patch/character/index.ts";

/**
 * Module object passed to `saveModule`. The module body is app-defined JSON, so
 * the record stays open beyond the two columns the writer reads.
 */

const BULK_INSERT_BATCH_ROWS = Math.max(
  1,
  Number.parseInt(process.env.RISUAI_SQL_BATCH_ROWS || "1000", 10) || 1000,
);

import type { CharacterTables } from "../../../../packages/protocol/tables/character.ts";
import type { SystemTables } from "../../../../packages/protocol/tables/system.ts";
import type { ChatTables } from "../../../../packages/protocol/tables/chat.ts";
import type { ColdTables } from "../../../../packages/protocol/tables/cold.ts";

/** Cold-storage value shape produced by the shared splitter. */

export type PostgresStorageContract = PostgresStorage;

type PostgresDatabase = CharacterTables &
  SystemTables &
  ChatTables &
  ColdTables;
/** Minimal injectable pool for character statement execution. */
type PoolLike = {
  connect(): Promise<{
    query(
      text: string,
      parameters: readonly unknown[],
    ): Promise<{
      rows: Record<string, unknown>[];
      rowCount?: number | null;
      command?: string;
    }>;
    release(): void;
  }>;
  end(): Promise<void>;
  options?: object;
};

export class PostgresStorage implements Pick<
  ISqlStorage,
  "character" | "close"
> {
  db: Kysely<PostgresDatabase>;

  constructor(
    connectionString: string,
    poolMax = 10,
    options?: {
      pool?: PoolLike;
    },
  ) {
    this.db = this.createDatabase(connectionString, poolMax, options?.pool);
  }

  private createDatabase(
    connectionString: string,
    poolMax: number,
    injected?: PoolLike,
  ) {
    const pool = injected ?? new Pool({ max: poolMax, connectionString });
    return new Kysely<PostgresDatabase>({
      dialect: new KyselyPostgresDialect({
        pool: {
          connect: () => pool.connect(),
          end: () => pool.end(),
          options: pool.options ?? {},
        } as PostgresPool,
      }),
    });
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }

  private readBase(keys: readonly (keyof CharacterFields)[]) {
    return this.db
      .selectFrom("character.characters as c")
      .select(["c.id", "c.kind"])
      .select((eb) => this.attributeProjection(eb, keys));
  }

  private attributeProjection(
    eb: ExpressionBuilder<
      PostgresDatabase & { c: CharacterTables["character.characters"] },
      "c"
    >,
    keys: readonly (keyof CharacterFields)[],
  ) {
    return eb
      .selectFrom("character.attributes as a")
      .select((eb) =>
        eb.fn.agg("jsonb_object_agg", ["a.key", "a.value"]).as("attributes"),
      )
      .whereRef("a.character_id", "=", "c.id")
      .where("a.key", "in", keys)
      .as("__attributes");
  }

  private addReadField(
    query: ReturnType<NPostgresStorage["readBase"]>,
    key: keyof CharacterFields,
  ) {
    if (Object.hasOwn(CHARACTER_FIELD_COLUMNS, key)) {
      const column =
        CHARACTER_FIELD_COLUMNS[key as keyof typeof CHARACTER_FIELD_COLUMNS];
      query = query.select(`c.${column}`);
    }
    return Object.hasOwn(CHARACTER_RELATIONS, key)
      ? query.select((eb) => this.relationProjection(eb, key))
      : query;
  }

  private relationProjection(
    eb: ExpressionBuilder<
      PostgresDatabase & { c: CharacterTables["character.characters"] },
      "c"
    >,
    key: keyof CharacterFields,
  ) {
    const relation =
      CHARACTER_RELATIONS[key as keyof typeof CHARACTER_RELATIONS];
    switch (relation.table) {
      case "character.greetings":
        return this.greetingProjection(eb, key, relation.discriminator[1]);
      case "character.scripts":
        return this.scriptProjection(eb, key, relation.discriminator[1]);
      case "character.assets":
        return this.assetProjection(eb, key, relation.discriminator[1]);
      default:
        return eb
          .selectFrom([`${relation.table} as t`])
          .select((eb) => eb.fn.jsonAgg("t").orderBy("t.position").as("rows"))
          .whereRef("t.character_id", "=", "c.id")
          .as(key);
    }
  }

  private greetingProjection(
    eb: ExpressionBuilder<
      PostgresDatabase & { c: CharacterTables["character.characters"] },
      "c"
    >,
    key: keyof CharacterFields,
    kind: "alternate" | "group-only",
  ) {
    return eb
      .selectFrom("character.greetings as t")
      .select((eb) => eb.fn.jsonAgg("t").orderBy("t.position").as("rows"))
      .whereRef("t.character_id", "=", "c.id")
      .where("t.greeting_type", "=", kind)
      .as(key);
  }

  private scriptProjection(
    eb: ExpressionBuilder<
      PostgresDatabase & { c: CharacterTables["character.characters"] },
      "c"
    >,
    key: keyof CharacterFields,
    kind: "custom" | "trigger",
  ) {
    return eb
      .selectFrom("character.scripts as t")
      .select((eb) => eb.fn.jsonAgg("t").orderBy("t.position").as("rows"))
      .whereRef("t.character_id", "=", "c.id")
      .where("t.script_kind", "=", kind)
      .as(key);
  }

  private assetProjection(
    eb: ExpressionBuilder<
      PostgresDatabase & { c: CharacterTables["character.characters"] },
      "c"
    >,
    key: keyof CharacterFields,
    source: "additional" | "character-card",
  ) {
    return eb
      .selectFrom("character.assets as t")
      .select((eb) => eb.fn.jsonAgg("t").orderBy("t.position").as("rows"))
      .whereRef("t.character_id", "=", "c.id")
      .where("t.asset_source", "=", source)
      .as(key);
  }

  private readStatement(
    keys: readonly (keyof CharacterFields)[],
    lookup: string | readonly string[],
  ) {
    let query = this.readBase(keys);
    for (const key of keys) query = this.addReadField(query, key);
    return (
      typeof lookup === "string"
        ? query.where("c.id", "=", lookup)
        : query.where("c.id", "in", lookup)
    )
      .$castTo<CharacterReadRow>()
      .compile();
  }

  character = {
    ref: (id: string): Character => {
      return new Character(
        id,
        (...keys) => this.character.read(id, ...keys),
        (patch) => this.character.update(id, patch),
      );
    },
    load: async (id: string): Promise<Character> => {
      const query = this.db
        .selectFrom("character.characters")
        .select(["id", "kind"])
        .where("id", "=", id)
        .compile();

      if ((await this.db.executeQuery(query)).rows[0]?.kind !== "character") {
        throw new Error(`Character not found: ${id}`);
      }
      return this.character.ref(id);
    },
    create: async (name: string): Promise<Character> => {
      const query = this.db
        .selectFrom(
          sql<{ id: string; storage_revision: string }>`
        system.character_apply_create(${JSON.stringify(encodeJsonValue(name))}::jsonb)
      `.as("result"),
        )
        .selectAll()
        .compile();
      const { id } = (await this.db.executeQuery(query)).rows[0];
      return this.character.ref(id);
    },
    read: async <K extends keyof CharacterFields>(
      id: string,
      ...keys: [K, ...K[]]
    ): Promise<Pick<CharacterFields, K>> => {
      assertId(id, "characterId");
      const unique = validateCharacterKeys(keys) as K[];
      const result = await this.db.executeQuery(this.readStatement(unique, id));
      const row = result.rows[0];
      if (row?.kind !== "character") {
        throw new Error(`Character not found: ${id}`);
      }
      const values = decodeCharacterReadRow(row, unique);
      return structuredClone(values);
    },
    readMany: async <K extends keyof CharacterFields>(
      ids: readonly string[],
      keys: readonly K[],
    ): Promise<Array<Pick<CharacterFields, K> & { chaId: string }>> => {
      const unique = validateCharacterKeys(keys) as K[];
      for (const id of ids) assertId(id, "characterId");
      const result = await this.db.executeQuery(
        this.readStatement(unique, ids),
      );
      return result.rows
        .filter((row) => row.kind === "character")
        .map((row) => {
          const values = decodeCharacterReadRow(row, unique);
          return structuredClone({ ...values, chaId: row.id });
        });
    },
    exists: async (
      id: string,
      trx?: Transaction<PostgresDatabase>,
    ): Promise<boolean> => {
      let query = (trx ?? this.db)
        .selectFrom("character.characters")
        .select("id")
        .where("id", "=", id)
        .where("kind", "=", "character");

      if (trx) query = query.forUpdate();

      return (await query.executeTakeFirst()) !== undefined;
    },
    update: async (id: string, patch: CharacterUpdate): Promise<void> => {
      validateCharacterUpdate(id, patch);
      if (Object.keys(patch).length === 0) return;
      const encoded = characterPatch(id, patch);
      await this.db.transaction().execute(async (trx) => {
        if (!(await this.character.exists(id, trx))) {
          throw new Error(`Character not found: ${id}`);
        }

        await sql`select system.character_begin_revision('character:update')`.execute(
          trx,
        );

        await trx
          .updateTable("character.characters")
          .set({ ...encoded.columns, updated_at: sql`now()` })
          .where("id", "=", id)
          .execute();

        // Delete all patched relations first so asset kinds can share position keys.
        for (const key of Object.keys(
          encoded.relations,
        ) as (keyof typeof encoded.relations)[]) {
          const relation = CHARACTER_RELATIONS[key];
          let deletion = trx
            .deleteFrom(relation.table)
            .where(sql.ref("character_id"), "=", id);
          if ("discriminator" in relation) {
            deletion = deletion.where(
              sql.ref(relation.discriminator[0]),
              "=",
              relation.discriminator[1],
            );
          }
          await deletion.execute();
        }
        for (const key of Object.keys(
          encoded.relations,
        ) as (keyof typeof encoded.relations)[]) {
          const relation = CHARACTER_RELATIONS[key];
          const rows = encoded.relations[key];
          if (!rows?.length) continue;
          let offset = 0;
          if (relation.table === "character.assets") {
            const remaining = await trx
              .selectFrom("character.assets")
              .select((eb) => eb.fn.max<number>("position").as("position"))
              .where("character_id", "=", id)
              .executeTakeFirstOrThrow();
            offset = (remaining.position ?? -1) + 1;
          }
          if (relation.table === "character.assets" && offset) {
            for (const row of rows) row.position += offset;
          }
          const batchSize = Math.min(BULK_INSERT_BATCH_ROWS, 1000);
          for (let start = 0; start < rows.length; start += batchSize) {
            await trx
              .insertInto(relation.table)
              .values(rows.slice(start, start + batchSize))
              .execute();
          }
        }
        if (encoded.attributeKeys.length) {
          await trx
            .deleteFrom("character.attributes")
            .where("character_id", "=", id)
            .where("key", "in", encoded.attributeKeys)
            .execute();
        }
        if (encoded.attributes.length) {
          await trx
            .insertInto("character.attributes")
            .values(encoded.attributes)
            .execute();
        }
      });
    },
    position: {
      max: async (): Promise<number> => {
        const query = this.db
          .selectFrom("character.characters")
          .select((eb) =>
            eb.fn.coalesce(eb.fn.max<number>("position"), eb.lit(-1)).as("max"),
          )
          .compile();
        return Number((await this.db.executeQuery(query)).rows[0].max);
      },
    },
  };
}
