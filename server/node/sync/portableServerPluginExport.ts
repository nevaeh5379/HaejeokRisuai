import type { LegacyBackupSqlRecord } from "../../../packages/backup-core/src/legacyRecords.ts";
import type { ServerSqlStorage } from "../serverTypes.ts";

export async function* iterateServerBackupPlugins(
  storage: Pick<ServerSqlStorage, "loadPlugins" | "loadPluginScript">,
): AsyncGenerator<Extract<LegacyBackupSqlRecord, { type: "plugin" }>> {
  const { plugins } = await storage.loadPlugins();
  for (const { id, position, ...data } of plugins) {
    const script = await storage.loadPluginScript(id);
    if (typeof script !== "string") {
      throw new Error(`Backup could not load plugin script ${id}`);
    }
    yield { type: "plugin", id, position, data, script };
  }
}
