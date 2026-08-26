import { describe, expect, it, vi } from "vitest";
import { CapacitorSqliteStorage } from "./capacitorSqliteStorage";

describe("CapacitorSqliteStorage startup", () => {
  it("loads all root settings in one native bridge query", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM system_settings s")) {
        return {
          values: [
            {
              setting_key: "language",
              node_id: 0,
              parent_node_id: null,
              node_order: 0,
              object_key: null,
              object_key_encoded: null,
              value_type: "string",
              text_value: "ko",
              encoded_text_value: null,
              number_value: null,
              boolean_value: null,
            },
            {
              setting_key: "lowSpecMode",
              node_id: 0,
              parent_node_id: null,
              node_order: 0,
              object_key: null,
              object_key_encoded: null,
              value_type: "boolean",
              text_value: null,
              encoded_text_value: null,
              number_value: null,
              boolean_value: 1,
            },
            {
              setting_key: "modules",
              node_id: null,
              parent_node_id: null,
              node_order: null,
              object_key: null,
              object_key_encoded: null,
              value_type: null,
              text_value: null,
              encoded_text_value: null,
              number_value: null,
              boolean_value: null,
            },
          ],
        };
      }
      if (sql.includes("FROM plugin_custom_storage")) return { values: [] };
      if (sql.includes("FROM characters")) return { values: [] };
      if (sql.includes("FROM system_storage_meta")) {
        return { values: [{ initialized: 1 }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const storage = new CapacitorSqliteStorage();
    (storage as any)._enabled = true;
    (storage as any).initialized = true;
    (storage as any).db = { query };

    const loaded = await storage.loadDatabase({ shallow: true });

    expect(loaded?.status).toBe("ready");
    expect((loaded?.database as any).language).toBe("ko");
    expect((loaded?.database as any).lowSpecMode).toBe(true);
    expect((loaded?.database as any).isDomainLoaded("modules")).toBe(false);
    expect(
      query.mock.calls.filter(([sql]) => sql.includes("FROM system_settings")),
    ).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(3);
  });
});
