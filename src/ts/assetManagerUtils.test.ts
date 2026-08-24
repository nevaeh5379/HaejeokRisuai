import { describe, expect, it } from "vitest";
import {
  applyBatchRenamePreview,
  buildBatchRenamePreview,
  collectAssetFolderSubtree,
  remapAssetFolderAssignments,
  selectAssetRange,
  stripAdditionalAssetFolderMetadata,
  type AssetTuple,
} from "./assetManagerUtils";

const assets: AssetTuple[] = [
  ["face_happy.png", "asset-a", "png"],
  ["face_sad.png", "asset-b", "png"],
  ["voice_01.mp3", "asset-c", "mp3"],
  ["untouched.png", "asset-d", "png"],
];

describe("buildBatchRenamePreview", () => {
  it("supports regex capture groups and sequence tokens", () => {
    const preview = buildBatchRenamePreview(assets, [0, 1], {
      pattern: "^face_(.+)\\.png$",
      replacement: "portrait_$1_{n:2}.png",
      flags: "i",
      startAt: 3,
    });

    expect(preview.error).toBe("");
    expect(preview.conflictCount).toBe(0);
    expect(preview.changedCount).toBe(2);
    expect(preview.items.map((item) => item.newName)).toEqual([
      "portrait_happy_03.png",
      "portrait_sad_04.png",
    ]);
  });
  it("detects collisions with assets outside the rename scope", () => {
    const preview = buildBatchRenamePreview(assets, [0], {
      pattern: ".*",
      replacement: "untouched.png",
    });

    expect(preview.conflictCount).toBe(1);
    expect(preview.items[0].error).toContain("Duplicate name");
  });

  it("reports invalid regular expressions without mutating data", () => {
    const preview = buildBatchRenamePreview(assets, [0, 1], {
      pattern: "([",
      replacement: "x",
    });

    expect(preview.error).not.toBe("");
    expect(preview.items).toEqual([]);
  });

  it("detects empty names produced by a replacement", () => {
    const preview = buildBatchRenamePreview(assets, [0], {
      pattern: ".+",
      replacement: "",
    });

    expect(preview.conflictCount).toBe(1);
    expect(preview.items[0].error).toBe("Name cannot be empty");
  });
});

describe("applyBatchRenamePreview", () => {
  it("applies only validated changed names", () => {
    const preview = buildBatchRenamePreview(assets, [0, 1], {
      pattern: "face_",
      replacement: "portrait_",
    });
    const renamed = applyBatchRenamePreview(assets, preview);

    expect(renamed[0][0]).toBe("portrait_happy.png");
    expect(renamed[1][0]).toBe("portrait_sad.png");
    expect(renamed[2]).toBe(assets[2]);
  });
});

describe("selectAssetRange", () => {
  it("selects ranges using the current filtered/sorted order", () => {
    expect(selectAssetRange([7, 2, 9, 4], 2, 4)).toEqual([2, 9, 4]);
    expect(selectAssetRange([7, 2, 9, 4], 4, 2)).toEqual([2, 9, 4]);
  });

  it("falls back to the target when the anchor is no longer visible", () => {
    expect(selectAssetRange([7, 2, 9], 100, 9)).toEqual([9]);
  });
});

describe("asset folder metadata", () => {
  it("keeps folder assignments attached when assets are renamed", () => {
    expect(
      remapAssetFolderAssignments(
        { "face_happy.png": "portraits", "voice_01.mp3": "voices" },
        [{ oldName: "face_happy.png", newName: "happy.png" }],
      ),
    ).toEqual({ "happy.png": "portraits", "voice_01.mp3": "voices" });
  });

  it("collects nested folders when a folder tree is removed", () => {
    const folders = [
      { id: "a", name: "A" },
      { id: "b", name: "B", parentId: "a" },
      { id: "c", name: "C", parentId: "b" },
      { id: "d", name: "D" },
    ];
    expect(Array.from(collectAssetFolderSubtree(folders, "a")).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("strips folder-only metadata for legacy-compatible exports", () => {
    const character = {
      name: "test",
      additionalAssets: [["a.png", "asset-a", "png"]],
      additionalAssetFolders: [{ id: "folder", name: "Folder" }],
      additionalAssetFolderAssignments: { "a.png": "folder" },
    };
    const portable = stripAdditionalAssetFolderMetadata(character);
    expect(portable.additionalAssets).toEqual(character.additionalAssets);
    expect("additionalAssetFolders" in portable).toBe(false);
    expect("additionalAssetFolderAssignments" in portable).toBe(false);
  });
});
