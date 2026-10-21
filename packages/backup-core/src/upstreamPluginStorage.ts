/** Import upstream v2026.10.210 cold plugin values into the SQL per-key layout. */
export async function restoreUpstreamPluginStorage(
  storage: Record<string, unknown> | undefined,
  readCold: (id: string) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = Object.create(null);
  const pointer = storage?._coldpluginIndex;
  if (typeof pointer === "string") {
    const index = await readCold(pointer);
    if (
      !index ||
      typeof index !== "object" ||
      !("type" in index) ||
      index.type !== "risu-plugin-storage-index" ||
      !("entries" in index) ||
      !Array.isArray(index.entries)
    ) {
      throw new Error(`Invalid upstream plugin storage index: ${pointer}`);
    }
    for (const entry of index.entries) {
      if (!entry || typeof entry.k !== "string") continue;
      if (typeof entry.l === "string") {
        const value = await readCold(entry.l);
        if (value === undefined)
          throw new Error(`Missing upstream plugin storage value: ${entry.l}`);
        result[entry.k] = value;
      } else if (typeof entry.s === "string") {
        result[entry.k] = JSON.parse(entry.s);
      }
    }
  }
  const legacy = storage?._coldplugin;
  if (legacy && typeof legacy === "object") {
    for (const key of Object.keys(legacy)) {
      const id = (legacy as Record<string, unknown>)[key];
      if (
        typeof id === "string" &&
        !Object.hasOwn(result, key) &&
        !Object.hasOwn(storage!, key)
      ) {
        result[key] = (await readCold(id)) ?? null;
      }
    }
  }
  if (storage) {
    for (const key of Object.keys(storage)) {
      if (key !== "_coldpluginIndex" && key !== "_coldplugin")
        result[key] = storage[key];
    }
  }
  return result;
}
