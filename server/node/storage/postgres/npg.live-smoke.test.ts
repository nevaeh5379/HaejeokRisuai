import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { NPostgresStorage } from "./postgresStorage.ts";

const url = process.env.NPG_SMOKE_URL as string;

async function revisionOf(raw: Pool): Promise<number> {
  const r = await raw.query(
    "SELECT revision FROM system.storage_meta WHERE singleton = TRUE",
  );
  return Number(r.rows[0].revision);
}

describe.skipIf(!url)("NPostgresStorage live smoke (throwaway)", () => {
  it("round-trips create/read/update/readMany on a real Postgres 17", async () => {
    const storage = new NPostgresStorage(url, 4);
    const raw = new Pool({ connectionString: url, max: 2 });
    try {
      const before = await revisionOf(raw);
      const ch = await storage.character.create("스모크 캐릭터");
      const chaId = ch.id;
      expect(typeof chaId).toBe("string");

      const defaults = await ch.get(
        "chaId",
        "type",
        "name",
        "bias",
        "triggerscript",
        "alternateGreetings",
      );
      expect(defaults.chaId).toBe(chaId);
      expect(defaults.type).toBe("character");
      expect(defaults.name).toBe("스모크 캐릭터");
      expect(defaults.bias).toEqual([]);
      expect(defaults.alternateGreetings).toEqual([]);
      expect(defaults.triggerscript).toHaveLength(2);

      const nulName = "이름\u0000개";
      await storage.character.update(chaId, {
        name: nulName,
        desc: "스모크 설명",
        bias: [["hello", -5]],
        alternateGreetings: ["안녕하세요", "반갑습니다"],
        triggerscript: [],
      });

      const after = await ch.get(
        "name",
        "desc",
        "bias",
        "alternateGreetings",
        "triggerscript",
      );
      expect(after.name).toBe(nulName);
      expect(after.desc).toBe("스모크 설명");
      expect(after.bias).toEqual([["hello", -5]]);
      expect(after.alternateGreetings).toEqual(["안녕하세요", "반갑습니다"]);
      expect(after.triggerscript).toEqual([]);

      const rev = await revisionOf(raw);
      expect(rev).toBeGreaterThanOrEqual(before + 2);
      let auditRows = await raw.query(
        "SELECT table_name, operation FROM system.audit_log WHERE revision_id = (SELECT id FROM system.revisions ORDER BY id DESC LIMIT 1) ORDER BY sequence",
      );
      let pairs = auditRows.rows.map(
        (r: { table_name: string; operation: string }) =>
          `${r.table_name}:${r.operation}`,
      );
      expect(pairs).toContain("character.characters:UPDATE");
      expect(pairs).toContain("character.biases:INSERT");
      expect(pairs).toContain("character.greetings:INSERT");
      expect(pairs).toContain("character.attributes:INSERT");

      await storage.character.update(chaId, {
        bias: [["bye", 3]],
        alternateGreetings: [],
      });
      const after2 = await ch.get("bias", "alternateGreetings");
      expect(after2.bias).toEqual([["bye", 3]]);
      expect(after2.alternateGreetings).toEqual([]);
      auditRows = await raw.query(
        "SELECT table_name, operation FROM system.audit_log WHERE revision_id = (SELECT id FROM system.revisions ORDER BY id DESC LIMIT 1) ORDER BY sequence",
      );
      pairs = auditRows.rows.map(
        (r: { table_name: string; operation: string }) =>
          `${r.table_name}:${r.operation}`,
      );
      expect(pairs).toContain("character.biases:DELETE");
      expect(pairs).toContain("character.biases:INSERT");
      expect(pairs).toContain("character.greetings:DELETE");
      expect(pairs).toContain("character.attributes:INSERT");

      const revBefore = await revisionOf(raw);
      await expect(
        storage.character.update("00000000-0000-4000-8000-000000000000", {
          desc: "x",
        }),
      ).rejects.toThrow("Character not found");
      expect(await revisionOf(raw)).toBe(revBefore);

      const many = await storage.character.readMany(
        [chaId, "00000000-0000-4000-8000-000000000000"],
        ["name", "bias"],
      );
      expect(many).toHaveLength(1);
      expect(many[0].chaId).toBe(chaId);
      expect(many[0].name).toBe(nulName);

      expect(await storage.character.load(chaId)).toBe(ch);
      expect(await storage.character.position.max()).toBeGreaterThanOrEqual(0);
    } finally {
      await storage.close();
      await raw.end();
    }
  });
});