import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(name: string): string {
  return fs.readFileSync(path.join(root, "server/node", name), "utf8");
}

describe("persistent branch schema parity", () => {
  it("defines branch graph tables for PostgreSQL", () => {
    const sql = read("postgres-schema.sql");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS chat.branches");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS chat.active_branches");
    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS chat.message_branch_links",
    );
  });

  it("keeps PostgreSQL composite message references restrictive instead of nulling chat_id", () => {
    const sql = read("postgres-schema.sql");
    expect(sql).not.toMatch(
      /FOREIGN KEY \(chat_id, (?:fork_message_id|head_message_id|parent_message_id)\)[^;\n]*ON DELETE SET NULL/,
    );
    expect(sql).toContain("CONSTRAINT branches_fork_message_fk FOREIGN KEY");
    expect(sql).toContain("CONSTRAINT branches_head_message_fk FOREIGN KEY");
    expect(sql).toContain(
      "CONSTRAINT message_branch_links_parent_message_fk FOREIGN KEY",
    );
    expect(sql).toContain(
      "DROP CONSTRAINT IF EXISTS branches_chat_id_fork_message_id_fkey",
    );
    expect(sql).toContain(
      "DROP CONSTRAINT IF EXISTS branches_chat_id_head_message_id_fkey",
    );
    expect(sql).toContain(
      "DROP CONSTRAINT IF EXISTS message_branch_links_chat_id_parent_message_id_fkey",
    );
  });

  it("avoids composite SET NULL branch FKs in Oracle fresh schemas", () => {
    expect(read("oracle-schema.sql")).not.toMatch(
      /FOREIGN KEY \(chat_id, (?:fork_message_id|head_message_id|parent_message_id)\)[^;\n]*ON DELETE SET NULL/,
    );
    expect(read("oracleStorage.cjs")).not.toMatch(
      /FOREIGN KEY \(chat_id, (?:fork_message_id|head_message_id|parent_message_id)\)[^;\n]*ON DELETE SET NULL/,
    );
  });

  it("defines branch graph tables for Azure SQL", () => {
    const sql = read("azure-schema.sql");
    expect(sql).toContain("OBJECT_ID(N'[chat].[branches]')");
    expect(sql).toContain("OBJECT_ID(N'[chat].[active_branches]')");
    expect(sql).toContain("OBJECT_ID(N'[chat].[message_branch_links]')");
  });

  it("defines branch graph tables for Oracle", () => {
    const sql = read("oracle-schema.sql");
    expect(sql).toContain("CREATE TABLE chat_branches");
    expect(sql).toContain("CREATE TABLE chat_active_branches");
    expect(sql).toContain("CREATE TABLE chat_message_branch_links");
  });
});

describe("PostgreSQL branch runtime safety", () => {
  it("does not issue concurrent queries on the same pg client", () => {
    const source = read("postgresStorage.cjs");
    expect(source).not.toMatch(/Promise\.all\([\s\S]{0,300}client\.query/);
  });

  it("detaches child and head references even when the removed link row is missing", () => {
    const source = read("postgresStorage.cjs");
    expect(source).toMatch(
      /SET parent_message_id = \(\s*SELECT removed\.parent_message_id/,
    );
    expect(source).toMatch(
      /SET head_message_id = \(\s*SELECT removed\.parent_message_id/,
    );
    expect(source).toMatch(
      /await this\.detachMessagesFromBranchGraph\(client,\s*\[\s*\{\s*chatId,\s*ids:\s*\[messageId\]\s*\},?\s*\]\s*\)/,
    );
  });
});

describe("legacy branch migration wiring", () => {
  for (const [label, file] of [
    ["PostgreSQL", "postgresStorage.cjs"],
    ["Azure SQL", "azureStorage.cjs"],
    ["Oracle", "oracleStorage.cjs"],
  ] as const) {
    it(`${label} migrates legacy branchState before creating a synthetic root`, () => {
      const source = read(file);
      expect(source).toContain("buildLegacyBranchMigrationPlan");
      expect(source).toContain("async migrateLegacyBranchState");
      expect(source).toMatch(
        /ensureChatBranchGraph[\s\S]{0,500}migrateLegacyBranchState/,
      );
    });

    it(`${label} keeps legacy branchState as archival recovery data after migration`, () => {
      const source = read(file);
      const start = source.indexOf("async migrateLegacyBranchState");
      const end = source.indexOf("async ensureChatBranchGraph", start);
      const migration = source.slice(start, end);
      expect(migration).not.toMatch(/DELETE[\s\S]{0,180}branchState/);
    });
  }

  for (const [label, file] of [
    ["PostgreSQL", "postgresStorage.cjs"],
    ["Azure SQL", "azureStorage.cjs"],
    ["Oracle", "oracleStorage.cjs"],
  ] as const) {
    it(`${label} exposes a single-read branch graph loader`, () => {
      const source = read(file);
      expect(source).toContain("async loadChatBranchGraph");
      expect(source).toContain("graph_generation_model");
    });
  }

  it("exposes the branch graph batch endpoint", () => {
    const source = read("server.cjs");
    expect(source).toContain("/api/database-v2/chats/:chatId/branches/graph");
    expect(source).toContain("loadChatBranchGraph(req.params.chatId)");
  });

  it("does not synthesize a PostgreSQL root when any branch already exists", () => {
    const source = read("postgresStorage.cjs");
    expect(source).toMatch(
      /NOT EXISTS \([\s\S]{0,160}FROM chat\.branches existing WHERE existing\.chat_id = chats\.id/,
    );
  });

  it("does not synthesize an Azure root when any branch already exists", () => {
    const source = read("azureStorage.cjs");
    expect(source).toMatch(
      /NOT EXISTS \([\s\S]{0,160}FROM \[chat\]\.\[branches\] existing[\s\S]{0,80}existing\.chat_id = chats\.id/,
    );
  });

  it("does not synthesize an Oracle root when any branch already exists", () => {
    const source = read("oracleStorage.cjs");
    expect(source).toMatch(
      /NOT EXISTS \([\s\S]{0,160}FROM chat_branches existing WHERE existing\.chat_id = chats\.id/,
    );
  });
});
