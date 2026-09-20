import { describe, expect, it } from "vitest";
import {
  createLocalBackupExportMetadata,
  createLocalBackupExportPlan,
} from "./exportPlan";

describe("createLocalBackupExportMetadata", () => {
  const date = new Date("2026-09-19T12:34:56.000Z");

  it("builds stable filenames for every export mode", () => {
    expect(createLocalBackupExportMetadata("native", date)).toEqual({
      baseName: "haejeokrisu_backup_2026-09-19",
      filename: "haejeokrisu_backup_2026-09-19.risubackup",
    });
    expect(createLocalBackupExportMetadata("compatible", date)).toEqual({
      baseName: "risu_compatible_backup_2026-09-19",
      filename: "risu_compatible_backup_2026-09-19.risubackup",
    });
    expect(createLocalBackupExportMetadata("partial", date)).toEqual({
      baseName: "haejeokrisu_partial_backup_2026-09-19",
      filename: "haejeokrisu_partial_backup_2026-09-19.risubackup",
    });
  });
});

describe("createLocalBackupExportPlan", () => {
  const assets = ["assets/a.png", "invalid.txt", "assets/b.png"];
  const inlays = [
    "inlay_11111111-1111-4111-8111-111111111111.risuinlay",
    "inlay_invalid.risuinlay",
  ];

  it("keeps native assets and valid inlays", () => {
    expect(
      createLocalBackupExportPlan({
        mode: "native",
        assetKeys: assets,
        inlayKeys: inlays,
      }),
    ).toEqual({
      assetKeys: ["assets/a.png", "assets/b.png"],
      inlayKeys: ["inlay_11111111-1111-4111-8111-111111111111.risuinlay"],
    });
  });

  it("omits inlays for compatible exports", () => {
    expect(
      createLocalBackupExportPlan({
        mode: "compatible",
        assetKeys: assets,
        inlayKeys: inlays,
      }),
    ).toEqual({
      assetKeys: ["assets/a.png", "assets/b.png"],
      inlayKeys: [],
    });
  });

  it("limits partial exports to essential assets", () => {
    expect(
      createLocalBackupExportPlan({
        mode: "partial",
        assetKeys: assets,
        inlayKeys: inlays,
        essentialAssetKeys: new Set(["assets/b.png"]),
      }),
    ).toEqual({
      assetKeys: ["assets/b.png"],
      inlayKeys: [],
    });
  });
});
