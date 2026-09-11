import type { SqlCommit } from "@risuai/protocol/sqlCommit.cjs";
import { mergeLegacyModulesIntoCommit } from "@risuai/storage-core/sqlCommitCompatibility";
import type { SqliteSelectRows } from "./sqliteAdminQueries";
import { loadSqliteSettingValue } from "./sqliteNodeValues";

export async function prepareSqliteModuleCommit<TPreset extends object>(
  selectRows: SqliteSelectRows,
  commit: SqlCommit<TPreset>,
): Promise<void> {
  if (!commit.modules || commit.replaceAll) return;
  const rows = await selectRows<{ count: number }>(
    "SELECT COUNT(*) AS count FROM module_records",
  );
  if (Number(rows[0]?.count) !== 0) return;
  mergeLegacyModulesIntoCommit(
    commit,
    await loadSqliteSettingValue(selectRows, "modules"),
  );
}

export async function validateSqlitePresetCommit<TPreset extends object>(
  selectRows: SqliteSelectRows,
  commit: SqlCommit<TPreset>,
): Promise<void> {
  if (!commit.presets) return;
  const originalIds = (
    await selectRows<{ preset_id: string }>(
      "SELECT preset_id FROM bot_presets ORDER BY position",
    )
  ).map((row) => row.preset_id);
  const ids = new Set(originalIds);
  if (commit.replaceAll) ids.clear();
  for (const id of commit.presets.deletes) ids.delete(id);
  for (const entry of commit.presets.upserts) ids.add(entry.id);

  if (ids.size === 0) {
    throw new Error("At least one bot preset must remain");
  }
  if (
    commit.presets.order &&
    (commit.presets.order.length !== ids.size ||
      new Set(commit.presets.order).size !== ids.size ||
      commit.presets.order.some((id) => !ids.has(id)))
  ) {
    throw new Error("Preset order must contain every preset ID exactly once");
  }
  if (
    commit.presets.activeId !== undefined &&
    !ids.has(commit.presets.activeId)
  ) {
    throw new Error("Active bot preset does not exist");
  }
  if (commit.presets.activeId !== undefined) return;

  const current = (await loadSqliteSettingValue(
    selectRows,
    "activeBotPresetId",
  )) as string | undefined;
  if (current && ids.has(current)) return;

  const index = originalIds.indexOf(current ?? "");
  commit.presets.activeId =
    originalIds.slice(index + 1).find((id) => ids.has(id)) ||
    originalIds
      .slice(0, Math.max(0, index))
      .reverse()
      .find((id) => ids.has(id)) ||
    (commit.presets.order || Array.from(ids))[0];
}
