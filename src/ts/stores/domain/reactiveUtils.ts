/**
 * Cheap structural hash of a value, used only for *one-shot* baselines taken
 * when an observer is created — never on every reactive re-run.
 */
export function snapshotFingerprint(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized) return "";
    let hash = 2166136261;
    for (let index = 0; index < serialized.length; index++) {
      hash ^= serialized.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${serialized.length}:${hash >>> 0}`;
  } catch {
    return "";
  }
}

/**
 * Recursively reads every nested property of a value so that Svelte 5's
 * reactivity system tracks deep mutations.  Must be called inside an
 * `$effect` (or `$effect.root`) callback for the dependency registration
 * to take effect.
 *
 * Primitive values, ArrayBuffer/Blob/Date instances are terminal — they
 * are read once and not descended into.
 */
export function trackDeep(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value as object)) return;
  seen.add(value as object);
  if (
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    value instanceof Blob ||
    value instanceof Date
  )
    return;
  if (value instanceof Map) {
    for (const [key, item] of value) {
      trackDeep(key, seen);
      trackDeep(item, seen);
    }
    return;
  }
  if (value instanceof Set) {
    for (const item of value) trackDeep(item, seen);
    return;
  }
  if (Array.isArray(value)) {
    void value.length;
    for (let index = 0; index < value.length; index++) {
      trackDeep(value[index], seen);
    }
    return;
  }
  for (const key of Object.keys(value))
    trackDeep((value as Record<string, unknown>)[key], seen);
}
