"use strict";

/**
 * Shared `sync()` domain blocks.
 *
 * Each block is one step of a sync payload: the ordering rules (delete, bump
 * positions, upsert, replace children, apply order) are identical for every
 * vendor, so they live here once and the dialect supplies the statements.
 * `sync()` 블록은 벤더와 무관한 순서 규칙으로 이루어지므로 여기서 한 번만
 * 구현하고, 문장은 방언이 만듭니다.
 */

import type { SqlDialect, SqlRow } from "./sqlDialect.ts";
import {
  mergeLegacyModulesIntoPayload,
  rebuildPluginRecords,
} from "./sqlStorageCommon.ts";
import type { SettingScalarRow, SettingValueRow } from "./relationalRows.ts";
import { asRows } from "./relationalRows.ts";
import {
  rebuildSettings,
  splitSetting,
} from "./postgres/postgresSettingsCodec.ts";

/** Position bump applied before reordering, large enough to avoid collisions. */
const POSITION_BUMP = 1000000000;

/** Shape of the `modules` section of a validated sync payload. */
export type ModuleSyncPayload = {
  deletes: readonly string[];
  upserts: readonly { id: string; position?: number; data: unknown }[];
  order?: readonly string[];
};

/** Context every domain block needs. */
export type SyncBlockContext = {
  /** Whether the payload replaces the whole database. */
  replaceAll: boolean;
  /** False when a storage-sync import already owns the legacy shape. */
  legacyMergeAllowed: boolean;
};

/**
 * Reads one root setting with its value rows and rebuilds the stored object.
 * `rebuildSettings` ignores value rows whose key was not selected, so the
 * scalar fallback only covers settings stored without value rows.
 */
async function readSettingValue(
  dialect: SqlDialect,
  key: string,
): Promise<SqlRow> {
  const settingRows = asRows<SettingScalarRow>(
    await dialect.selectByKey("system.settings", "key", key),
  );
  const valueRows = asRows<SettingValueRow>(
    await dialect.selectByKey("system.setting_values", "setting_key", key),
  );
  const rebuilt: SqlRow = rebuildSettings(settingRows, valueRows);
  for (const row of settingRows) {
    if (!Object.prototype.hasOwnProperty.call(rebuilt, row.key)) {
      rebuilt[row.key] = row.text_val;
    }
  }
  return rebuilt;
}

/**
 * Applies the `modules` section: legacy settings import, deletes, position
 * bump, record upserts, value replacement and the final ordering.
 */
export async function syncModuleRecords(
  dialect: SqlDialect,
  modules: ModuleSyncPayload,
  context: SyncBlockContext,
  payload: Parameters<typeof mergeLegacyModulesIntoPayload>[0],
): Promise<void> {
  const existing = await dialect.selectOrdered("system.module_records");
  if (
    !context.replaceAll &&
    existing.length === 0 &&
    context.legacyMergeAllowed
  ) {
    const legacy = await readSettingValue(dialect, "modules");
    mergeLegacyModulesIntoPayload(payload, legacy.modules);
  }

  if (modules.deletes.length > 0) {
    await dialect.deleteByKeys(
      "system.module_records",
      ["module_id"],
      modules.deletes.map((id) => [id]),
    );
  }
  if (modules.order) {
    await dialect.bumpPositions("system.module_records", POSITION_BUMP);
  }

  const positions = new Map<string, number>(
    existing.map((row) => [String(row.module_id), Number(row.position)]),
  );
  if (modules.upserts.length > 0) {
    await dialect.upsertRows(
      "system.module_records",
      modules.upserts.map((entry) => ({
        module_id: entry.id,
        position: entry.position ?? positions.get(entry.id) ?? 0,
      })),
    );
    await dialect.deleteByKeys(
      "system.module_values",
      ["module_id"],
      modules.upserts.map((entry) => [entry.id]),
    );
    await dialect.insertRows(
      "system.module_values",
      modules.upserts.flatMap((entry) =>
        splitSetting(entry.id, entry.data).values.map(
          (row: SettingValueRow) => ({
            ...row,
            module_id: row.setting_key,
          }),
        ),
      ),
    );
  }

  if (modules.order) {
    await dialect.setPositions(
      "system.module_records",
      "module_id",
      modules.order,
    );
  }
}

export { POSITION_BUMP, readSettingValue };
export type { SqlRow };

/** Rebuilds plugin metadata rows; re-exported so drivers import from one place. */
export { rebuildPluginRecords };
