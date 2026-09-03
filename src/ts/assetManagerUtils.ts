export type AssetTuple = [string, string, string];

export type AssetFolder = {
  id: string;
  name: string;
  parentId?: string;
};

export type BatchRenameOptions = {
  pattern: string;
  replacement: string;
  flags?: string;
  startAt?: number;
};

export type BatchRenamePreviewItem = {
  originalIndex: number;
  oldName: string;
  newName: string;
  changed: boolean;
  error?: string;
};

export type BatchRenamePreview = {
  items: BatchRenamePreviewItem[];
  error: string;
  changedCount: number;
  conflictCount: number;
};

function formatSequenceToken(value: number, widthText?: string) {
  const width = widthText ? Number.parseInt(widthText, 10) : 0;
  return width > 0 ? String(value).padStart(width, "0") : String(value);
}

function expandSequenceTokens(
  value: string,
  sequence: number,
  originalIndex: number,
) {
  return value
    .replace(/\{n(?::(\d+))?\}/g, (_, width) =>
      formatSequenceToken(sequence, width),
    )
    .replace(/\{index(?::(\d+))?\}/g, (_, width) =>
      formatSequenceToken(originalIndex + 1, width),
    );
}
export function buildBatchRenamePreview(
  assets: AssetTuple[],
  targetIndices: number[],
  options: BatchRenameOptions,
): BatchRenamePreview {
  const flags = options.flags ?? "";
  let regex: RegExp;
  try {
    regex = new RegExp(options.pattern, flags);
  } catch (error) {
    return {
      items: [],
      error:
        error instanceof Error ? error.message : "Invalid regular expression",
      changedCount: 0,
      conflictCount: 0,
    };
  }

  const uniqueTargets = Array.from(new Set(targetIndices)).filter(
    (index) => index >= 0 && index < assets.length,
  );
  const targetSet = new Set(uniqueTargets);
  const items: BatchRenamePreviewItem[] = uniqueTargets.map(
    (originalIndex, sequenceIndex) => {
      const oldName = assets[originalIndex]?.[0] ?? "";
      const perItemRegex = new RegExp(regex.source, regex.flags);
      const replaced = oldName.replace(perItemRegex, options.replacement);
      const newName = expandSequenceTokens(
        replaced,
        (options.startAt ?? 1) + sequenceIndex,
        originalIndex,
      ).trim();
      return { originalIndex, oldName, newName, changed: oldName !== newName };
    },
  );

  const previewByIndex = new Map(
    items.map((item) => [item.originalIndex, item]),
  );
  const finalNameOwners = new Map<string, number[]>();
  for (let index = 0; index < assets.length; index++) {
    const previewItem = targetSet.has(index)
      ? previewByIndex.get(index)
      : undefined;
    const finalName = previewItem?.newName ?? assets[index]?.[0] ?? "";
    const owners = finalNameOwners.get(finalName) ?? [];
    owners.push(index);
    finalNameOwners.set(finalName, owners);
  }
  let conflictCount = 0;
  for (const item of items) {
    if (!item.newName) {
      item.error = "Name cannot be empty";
      conflictCount++;
      continue;
    }
    const owners = finalNameOwners.get(item.newName) ?? [];
    if (owners.length > 1) {
      item.error = `Duplicate name (${owners.length} assets)`;
      conflictCount++;
    }
  }

  return {
    items,
    error: "",
    changedCount: items.filter((item) => item.changed).length,
    conflictCount,
  };
}

export function applyBatchRenamePreview(
  assets: AssetTuple[],
  preview: BatchRenamePreview,
): AssetTuple[] {
  if (preview.error || preview.conflictCount > 0) return assets;
  const names = new Map(
    preview.items
      .filter((item) => item.changed)
      .map((item) => [item.originalIndex, item.newName]),
  );
  return assets.map((asset, index) => {
    const nextName = names.get(index);
    return nextName === undefined ? asset : [nextName, asset[1], asset[2]];
  });
}

export function selectAssetRange(
  orderedIndices: number[],
  anchorIndex: number,
  targetIndex: number,
): number[] {
  const anchorPosition = orderedIndices.indexOf(anchorIndex);
  const targetPosition = orderedIndices.indexOf(targetIndex);
  if (anchorPosition < 0 || targetPosition < 0) return [targetIndex];
  const start = Math.min(anchorPosition, targetPosition);
  const end = Math.max(anchorPosition, targetPosition);
  return orderedIndices.slice(start, end + 1);
}

export function remapAssetFolderAssignments(
  assignments: Record<string, string> | undefined,
  renames: Array<{ oldName: string; newName: string }>,
): Record<string, string> {
  const next = { ...(assignments ?? {}) };
  for (const { oldName, newName } of renames) {
    if (oldName === newName || !(oldName in next)) continue;
    const folderId = next[oldName];
    delete next[oldName];
    next[newName] = folderId;
  }
  return next;
}

export function stripAdditionalAssetFolderMetadata<
  T extends Record<string, any>,
>(character: T): T {
  const copy = { ...character };
  delete copy.additionalAssetFolders;
  delete copy.additionalAssetFolderAssignments;
  return copy as T;
}

export function collectAssetFolderSubtree(
  folders: AssetFolder[],
  rootId: string,
): Set<string> {
  const result = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      if (
        folder.parentId &&
        result.has(folder.parentId) &&
        !result.has(folder.id)
      ) {
        result.add(folder.id);
        changed = true;
      }
    }
  }
  return result;
}
