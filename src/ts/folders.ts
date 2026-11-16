import type { PromptPresetFolder } from "./storage/database/schema";

export interface FolderGroup {
  /** `null` for the uncategorized group. */
  folder: PromptPresetFolder | null;
  /** Indexes into the original item array, in original order. */
  indexes: number[];
}

/**
 * Groups item indexes by folder. The uncategorized group comes first, then
 * folders in the user's order. Items pointing at a missing folder are treated
 * as uncategorized so nothing disappears from the UI.
 */
export function groupByFolder(
  itemFolderIds: (string | undefined | null)[],
  folders: PromptPresetFolder[],
): FolderGroup[] {
  const byId = new Map<string, number[]>();
  for (const folder of folders) byId.set(folder.id, []);
  const uncategorized: number[] = [];
  itemFolderIds.forEach((folderId, index) => {
    const bucket = folderId ? byId.get(folderId) : undefined;
    if (bucket) bucket.push(index);
    else uncategorized.push(index);
  });
  return [
    { folder: null, indexes: uncategorized },
    ...folders.map((folder) => ({
      folder,
      indexes: byId.get(folder.id) ?? [],
    })),
  ];
}
