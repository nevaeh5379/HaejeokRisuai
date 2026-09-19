import type { LocalBackupMode } from "./api";
import { INLAY_RE } from "./entryPolicy";

export interface LocalBackupExportMetadata {
  baseName: string;
  filename: string;
}

export interface LocalBackupExportPlanInput {
  mode: LocalBackupMode;
  assetKeys: readonly string[];
  inlayKeys?: readonly string[];
  essentialAssetKeys?: ReadonlySet<string>;
}

export interface LocalBackupExportPlan {
  assetKeys: string[];
  inlayKeys: string[];
}

export function createLocalBackupExportMetadata(
  mode: LocalBackupMode,
  date = new Date(),
): LocalBackupExportMetadata {
  const dateStr = date.toISOString().slice(0, 10);
  const baseName =
    mode === "compatible"
      ? `risu_compatible_backup_${dateStr}`
      : mode === "partial"
        ? `haejeokrisu_partial_backup_${dateStr}`
        : `haejeokrisu_backup_${dateStr}`;

  return {
    baseName,
    filename: `${baseName}.risubackup`,
  };
}

export function createLocalBackupExportPlan(
  input: LocalBackupExportPlanInput,
): LocalBackupExportPlan {
  let assetKeys = input.assetKeys.filter(
    (key): key is string =>
      typeof key === "string" && key.startsWith("assets/"),
  );

  if (input.mode === "partial") {
    const essentialAssetKeys = input.essentialAssetKeys ?? new Set<string>();
    assetKeys = assetKeys.filter((key) => essentialAssetKeys.has(key));
  }

  const inlayKeys =
    input.mode === "native"
      ? (input.inlayKeys ?? []).filter(
          (key): key is string => typeof key === "string" && INLAY_RE.test(key),
        )
      : [];

  return { assetKeys, inlayKeys };
}
