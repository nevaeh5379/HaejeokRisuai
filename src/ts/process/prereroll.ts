const MAX_REROLL_ENTRIES = 64;
const rerolls = new Map<string, string[]>();
const rerollIndex = new Map<string, number>();

function evictOldestRerolls(): void {
  while (rerolls.size > MAX_REROLL_ENTRIES) {
    const oldest = rerolls.keys().next().value;
    if (oldest === undefined) break;
    rerolls.delete(oldest);
    rerollIndex.delete(oldest);
  }
}

export function Prereroll(genId: string) {
  const list = rerolls.get(genId);
  if (list) {
    const index = (rerollIndex.get(genId) ?? 0) + 1;
    rerollIndex.set(genId, index);
    return list[index] ?? null;
  }
  return null;
}

export function PreUnreroll(genId: string) {
  const list = rerolls.get(genId);
  if (list) {
    const index = (rerollIndex.get(genId) ?? 0) - 1;
    if (index < 0) {
      return null;
    }
    rerollIndex.set(genId, index);
    return list[index] ?? null;
  }
  return null;
}

export function addRerolls(genId: string, values: string[]) {
  rerolls.delete(genId);
  rerolls.set(genId, values);
  rerollIndex.set(genId, 0);
  evictOldestRerolls();
}

export function clearRerolls(): void {
  rerolls.clear();
  rerollIndex.clear();
}
