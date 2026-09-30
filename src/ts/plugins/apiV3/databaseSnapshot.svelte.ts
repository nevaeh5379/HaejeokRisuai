// Host-only envelope. The sandbox unwraps this synchronously immediately before
// postMessage; plugins still receive the ordinary detached database object.
export class DeferredDatabaseSnapshot {
  constructor(private snapshot: (() => Record<string, unknown>) | undefined) {}

  materialize(): Record<string, unknown> {
    const snapshot = this.snapshot;
    this.snapshot = undefined;
    if (!snapshot) throw new Error("Database snapshot already materialized");
    return snapshot();
  }
}

export async function prepareDatabaseSnapshot(
  database: Record<string, unknown>,
  allowedKeys: string[],
  loadPlugins: () => Promise<unknown>,
  includeOnly: string[] | "all" = "all",
): Promise<DeferredDatabaseSnapshot> {
  const keys = allowedKeys.filter(
    (key) => includeOnly === "all" || includeOnly.includes(key),
  );
  // Complete lazy I/O before creating any large detached history arrays.
  const plugins = keys.includes("plugins") ? await loadPlugins() : undefined;
  return new DeferredDatabaseSnapshot(() => {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = $state.snapshot(
        key === "plugins" ? plugins : database[key],
      );
    }
    return result;
  });
}
