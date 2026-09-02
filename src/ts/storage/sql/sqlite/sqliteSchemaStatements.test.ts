import { describe, expect, it } from "vitest";
import sqliteSchemaSql from "./sqlite-schema.sql?raw";
import { isSqlitePragmaStatement, splitSqliteStatements } from "./sqliteSchemaStatements";

describe("splitSqliteStatements", () => {
  it("keeps trigger bodies and quoted/comment semicolons intact", () => {
    const statements = splitSqliteStatements(`
      CREATE TABLE demo (value TEXT);
      INSERT INTO demo VALUES ('a;b'); -- ; ignored
      CREATE VIEW demo_view AS SELECT value AS trigger FROM demo;
      /* ; ignored */
      CREATE TRIGGER demo_trigger AFTER INSERT ON demo
      BEGIN
        UPDATE demo SET value = CASE WHEN value = 'x;y' THEN 'z' ELSE value END;
        INSERT INTO demo VALUES ('trigger;body');
      END;
      CREATE INDEX demo_idx ON demo(value);
    `);
    expect(statements).toHaveLength(5);
    expect(statements[2]).toContain("CREATE VIEW demo_view");
    expect(statements[3]).toContain("CREATE TRIGGER demo_trigger");
    expect(statements[3]).toContain("INSERT INTO demo VALUES ('trigger;body')");
    expect(statements[4]).toContain("CREATE INDEX demo_idx");
  });

  it("recognizes PRAGMA statements after leading comments", () => {
    expect(isSqlitePragmaStatement("-- comment\nPRAGMA foreign_keys = ON;"))
      .toBe(true);
    expect(isSqlitePragmaStatement("/* comment */ CREATE TABLE x (id INTEGER);"))
      .toBe(false);
  });

  it("splits the production schema into executable statements", () => {
    const statements = splitSqliteStatements(sqliteSchemaSql);
    const triggers = statements.filter((statement) =>
      /^\s*CREATE\s+TRIGGER\b/i.test(statement),
    );
    expect(triggers).toHaveLength(3);
    expect(triggers.every((statement) => /\bBEGIN\b[\s\S]*\bEND\s*;?\s*$/i.test(statement))).toBe(true);
    expect(statements.some((statement) => statement.includes("CREATE TABLE IF NOT EXISTS messages"))).toBe(true);
  });
});
