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
