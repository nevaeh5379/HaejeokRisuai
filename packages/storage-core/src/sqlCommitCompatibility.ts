import type { SqlCommit } from "@risuai/protocol/src/sqlCommit.ts";

export function mergeLegacyModulesIntoCommit<TPreset extends object>(
  commit: SqlCommit<TPreset>,
  legacyModules: unknown,
): void {
  if (!commit.modules || !Array.isArray(legacyModules)) return;

  const deleted = new Set(commit.modules.deletes);
  const changed = new Set<string>();
  for (const entry of commit.modules.upserts) {
    changed.add(entry.id);
  }

  let order = commit.modules.order;
  if (!order) {
    const orderSet = new Set<string>();
    for (const module of legacyModules) {
      if (
        module &&
        typeof module === "object" &&
        typeof (module as { id?: unknown }).id === "string"
      ) {
        const id = (module as { id: string }).id;
        if (!deleted.has(id)) {
          orderSet.add(id);
        }
      }
    }
    for (const entry of commit.modules.upserts) {
      if (!deleted.has(entry.id)) {
        orderSet.add(entry.id);
      }
    }
    order = Array.from(orderSet);
  }

  const positions = new Map<string, number>();
  for (let position = 0; position < order.length; position++) {
    positions.set(order[position], position);
  }

  const migrated: Array<{
    id: string;
    position: number;
    data: { id: string } & Record<string, unknown>;
  }> = [];

  for (const module of legacyModules) {
    if (
      module &&
      typeof module === "object" &&
      typeof (module as { id?: unknown }).id === "string"
    ) {
      const data = module as { id: string } & Record<string, unknown>;
      if (!deleted.has(data.id) && !changed.has(data.id)) {
        migrated.push({
          id: data.id,
          position: positions.get(data.id) ?? 0,
          data,
        });
      }
    }
  }

  commit.modules.upserts = [...migrated, ...commit.modules.upserts];
  commit.modules.order = order;
  if (!commit.root.deletes.includes("modules")) {
    commit.root.deletes.push("modules");
  }
}
