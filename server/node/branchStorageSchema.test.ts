import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const root = process.cwd()

function read(name: string): string {
  return fs.readFileSync(path.join(root, "server/node", name), "utf8")
}

describe("persistent branch schema parity", () => {
  it("defines branch graph tables for PostgreSQL", () => {
    const sql = read("postgres-schema.sql")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS chat.branches")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS chat.active_branches")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS chat.message_branch_links")
  })

  it("defines branch graph tables for Azure SQL", () => {
    const sql = read("azure-schema.sql")
    expect(sql).toContain("OBJECT_ID(N'[chat].[branches]')")
    expect(sql).toContain("OBJECT_ID(N'[chat].[active_branches]')")
    expect(sql).toContain("OBJECT_ID(N'[chat].[message_branch_links]')")
  })

  it("defines branch graph tables for Oracle", () => {
    const sql = read("oracle-schema.sql")
    expect(sql).toContain("CREATE TABLE chat_branches")
    expect(sql).toContain("CREATE TABLE chat_active_branches")
    expect(sql).toContain("CREATE TABLE chat_message_branch_links")
  })
})

describe("legacy branch migration wiring", () => {
  for (const [label, file] of [
    ["PostgreSQL", "postgresStorage.cjs"],
    ["Azure SQL", "azureStorage.cjs"],
    ["Oracle", "oracleStorage.cjs"],
  ] as const) {
    it(`${label} migrates legacy branchState before creating a synthetic root`, () => {
      const source = read(file)
      expect(source).toContain("buildLegacyBranchMigrationPlan")
      expect(source).toContain("async migrateLegacyBranchState")
      expect(source).toMatch(/ensureChatBranchGraph[\s\S]{0,500}migrateLegacyBranchState/)
    })
  }

  it("does not synthesize a PostgreSQL root when any branch already exists", () => {
    const source = read("postgresStorage.cjs")
    expect(source).toMatch(/NOT EXISTS \([\s\S]{0,160}FROM chat\.branches existing WHERE existing\.chat_id = chats\.id/)
  })

  it("does not synthesize an Azure root when any branch already exists", () => {
    const source = read("azureStorage.cjs")
    expect(source).toMatch(/NOT EXISTS \([\s\S]{0,160}FROM \[chat\]\.\[branches\] existing[\s\S]{0,80}existing\.chat_id = chats\.id/)
  })

  it("does not synthesize an Oracle root when any branch already exists", () => {
    const source = read("oracleStorage.cjs")
    expect(source).toMatch(/NOT EXISTS \([\s\S]{0,160}FROM chat_branches existing WHERE existing\.chat_id = chats\.id/)
  })
})
