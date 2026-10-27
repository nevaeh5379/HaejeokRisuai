import type { ISqlStorage } from "@risuai/storage-core/sqlStorage";
import { commitSqlChanges } from "../sql/sqlCommitCoordinator";

/** Repair only the stale active preset produced by the old SQL migration. */
export async function repairLegacyModuleIntegration(
  storage: ISqlStorage,
  activeId: string,
  position: number,
  legacyValue: unknown,
): Promise<boolean> {
  if (typeof legacyValue !== "string" || !legacyValue) return false;
  const preset = await storage.loadBotPreset(activeId);
  if (!preset || preset.moduleIntergration !== undefined) return false;
  const { id, ...data } = preset;
  await commitSqlChanges(storage, {
    baseRevision: storage.getRevision(),
    action: "preset:repair-module-integration",
    root: { upserts: [], deletes: [] },
    presets: {
      upserts: [
        { id, position, data: { ...data, moduleIntergration: legacyValue } },
      ],
      deletes: [],
    },
    characters: [],
    chats: [],
    chatManifests: [],
    messages: [],
    messageManifests: [],
  });
  return true;
}
