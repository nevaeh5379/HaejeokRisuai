import type { HypaV3Data, SerializableHypaV3Data } from "./types.js";

export function deserializeHypaV3Data(
  serialized: SerializableHypaV3Data,
): HypaV3Data {
  const { lastSelectedSummaries: _legacySelection, ...rest } = serialized;

  return {
    ...rest,
    summaries: serialized.summaries.map((summary) => ({
      ...summary,
      // Old JSON saves may contain null where an optional memo was undefined.
      chatMemos: new Set(
        summary.chatMemos.map((memo) => (memo === null ? undefined : memo)),
      ),
    })),
  } as HypaV3Data;
}

export function serializeHypaV3Data(data: HypaV3Data): SerializableHypaV3Data {
  return {
    ...data,
    summaries: data.summaries.map((summary) => ({
      ...summary,
      chatMemos: [...summary.chatMemos],
    })),
  };
}

/** Mutates data so large summary arrays do not need to be duplicated. */
export function cleanOrphanedSummaries(
  currentChatMemos: Iterable<string | undefined>,
  data: HypaV3Data,
): number {
  const memoSet = new Set(currentChatMemos);
  const originalLength = data.summaries.length;
  data.summaries = data.summaries.filter((summary) =>
    isSubset(summary.chatMemos, memoSet),
  );
  return originalLength - data.summaries.length;
}

function isSubset<T>(
  subset: Set<T | undefined>,
  superset: Set<T | undefined>,
): boolean {
  for (const value of subset) {
    if (!superset.has(value)) return false;
  }
  return true;
}

export function combineScoredLists<T>(
  scoredLists: [T, number][][],
  weightForList?: (listIndex: number, totalLists: number) => number,
): T[] {
  const scores = new Map<T, number>();

  for (let listIndex = 0; listIndex < scoredLists.length; listIndex++) {
    const weight = weightForList
      ? weightForList(listIndex, scoredLists.length)
      : 1 / scoredLists.length;
    for (const [item, score] of scoredLists[listIndex]) {
      scores.set(item, (scores.get(item) ?? 0) + score * weight);
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([item]) => item);
}

export function reciprocalRankFusion<T>(rankedLists: T[][], k = 60): T[] {
  const scores = new Map<T, number>();
  for (const list of rankedLists) {
    for (let index = 0; index < list.length; index++) {
      const item = list[index];
      scores.set(item, (scores.get(item) ?? 0) + 1 / (k + index + 1));
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([item]) => item);
}

export function childToParentRRF<Child, Parent>(
  rankedChildren: Child[],
  parentFor: (child: Child) => Parent,
  k = 60,
): Parent[] {
  const scores = new Map<Parent, number>();
  for (let index = 0; index < rankedChildren.length; index++) {
    const parent = parentFor(rankedChildren[index]);
    scores.set(parent, (scores.get(parent) ?? 0) + 1 / (k + index + 1));
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([parent]) => parent);
}

export function normalizeScores<T>(scoredList: [T, number][]): [T, number][] {
  if (scoredList.length === 0) return [];
  const values = scoredList.map(([, score]) => score);
  const min = Math.min(...values);
  const max = Math.max(...values);

  if (min === max) {
    return scoredList.map(([item]) => [item, min === 0 ? 0 : 1]);
  }
  return scoredList.map(([item, score]) => [item, (score - min) / (max - min)]);
}
