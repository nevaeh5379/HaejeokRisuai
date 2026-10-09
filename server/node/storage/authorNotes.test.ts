// @vitest-environment node
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AuthorNoteSql } from "../../../packages/protocol/src/authorNoteSql.ts";

const require = createRequire(import.meta.url);
import { authorNoteDatabase, notes } from "./authorNotes.ts";
import { hashAuthorNote } from "../../../packages/protocol/src/authorNotes.ts";

describe.each(["postgres", "oracle", "azure"] as const)(
  "author note SQL adapter: %s",
  (vendor) => {
    it("binds exact content and restores snapshots with recomputed hashes", async () => {
      const database = new DatabaseSync(":memory:");
      database.exec(
        readFileSync("packages/storage-sqlite/src/schema/schema.sql", "utf8"),
      );
      const run = (sql: string, values: unknown[] = []) => {
        const converted = sql
          .replace(/\[system\]\.\[([^\]]+)\]/g, "$1")
          .replace(/system\.revisions/g, "system_revisions")
          .replace(/system\./g, "")
          .replace(/\brevisions\b/g, "system_revisions")
          .replace(/\$\d+|:\d+|@p\d+/g, "?")
          .replace(/EMPTY_CLOB\(\)/g, "''");
        const binds = values.map((value: any) => {
          if (value && typeof value === "object" && "val" in value)
            return value.val;
          return typeof value === "boolean" ? Number(value) : value;
        });
        const statement = database.prepare(converted);
        return /^SELECT/.test(converted)
          ? statement.all(...(binds as any[]))
          : (statement.run(...(binds as any[])), []);
      };
      const oracleRaw = {
        execute: async (sql: string, bind: unknown[]) => ({
          rows: run(sql, bind).map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([key, value]) => [
                key.toUpperCase(),
                value,
              ]),
            ),
          ),
        }),
      };
      const client =
        vendor === "postgres"
          ? {
              query: async (sql: string, bind: unknown[]) => ({
                rows: run(sql, bind),
              }),
            }
          : vendor === "oracle"
            ? {
                __risuRawConnection: oracleRaw,
                execute: () => {
                  throw new Error("Legacy sentinel path must not be used");
                },
              }
            : {
                request: () => {
                  const bindings: unknown[] = [];
                  return {
                    input: (_name: string, _type: unknown, value: unknown) =>
                      bindings.push(value),
                    query: async (sql: string) => ({
                      recordset: run(sql, bindings),
                    }),
                  };
                },
              };
      const db = authorNoteDatabase(vendor, client);
      const body = " \n한글🚀\r\n ";
      await notes.applyAuthorNotes(db, [
        { type: "create", id: "note", name: "", content: body },
      ]);
      expect(await notes.readAuthorNote(db, "note")).toMatchObject({
        name: "",
        content: body,
        contentHash: await hashAuthorNote(body),
      });
      const snapshot = await notes.exportAuthorNotes(db);
      snapshot.globalAuthorNotes[1].contentHash = "bad";
      await notes.applyAuthorNotes(db, [
        {
          type: "restore",
          rows: snapshot.globalAuthorNotes,
          allowScriptWrite: true,
        },
      ]);
      expect(await notes.allowAuthorNoteScriptWrite(db)).toBe(true);
      const note = (await notes.readAuthorNote(db, "note"))!;
      expect(note.contentHash).toBe(await hashAuthorNote(body));
      await notes.applyAuthorNotes(db, [
        {
          type: "content",
          id: "note",
          content: "",
          expectedHash: note.contentHash,
        },
      ]);
      expect(await notes.readAuthorNote(db, "note")).toMatchObject({
        content: "",
        contentHash: await hashAuthorNote(""),
      });
      await expect(
        notes.applyAuthorNotes(db, [
          {
            type: "content",
            id: "note",
            content: "stale",
            expectedHash: note.contentHash,
          },
        ]),
      ).rejects.toMatchObject({ code: "conflict" });
      await notes.applyAuthorNotes(db, [
        { type: "rename", id: "note", name: "duplicate" },
      ]);
      expect(await notes.readAuthorNote(db, "note")).toMatchObject({
        name: "duplicate",
        content: "",
      });
      database.close();
    });
  },
);
