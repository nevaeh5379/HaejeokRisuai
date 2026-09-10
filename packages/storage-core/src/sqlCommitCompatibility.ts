import type { SqlCommit } from "@risuai/protocol/sqlCommit.cjs";

export function mergeLegacyModulesIntoCommit<TPreset extends object>(
  commit: SqlCommit<TPreset>,
  legacyModules: unknown,
): void {
  if (!commit.modules || !Array.isArray(legacyModules)) return;

  const deleted = new Set(commit.modules.deletes);
  const changed = new Set(commit.modules.upserts.map((entry) => entry.id));
  const inferredOrder = [
    ...legacyModules
      .filter((module): module is { id: string } & Record<string, unknown> =>
        Boolean(
          module &&
          typeof module === "object" &&
          typeof (module as { id?: unknown }).id === "string",
        ),
      )
      .map((module) => module.id)
      .filter((id) => !deleted.has(id)),
    ...commit.modules.upserts
      .map((entry) => entry.id)
      .filter((id) => !deleted.has(id)),
  ];
  const order = commit.modules.order ?? [...new Set(inferredOrder)];
  const positions = new Map(order.map((id, position) => [id, position]));
  const migrated = legacyModules.flatMap((module) => {
    if (
      !module ||
      typeof module !== "object" ||
      typeof (module as { id?: unknown }).id !== "string"
    ) {
      return [];
    }
    const data = module as { id: string } & Record<string, unknown>;
    if (deleted.has(data.id) || changed.has(data.id)) return [];
    return [{ id: data.id, position: positions.get(data.id) ?? 0, data }];
  });
  commit.modules.upserts = [...migrated, ...commit.modules.upserts];
  commit.modules.order = order;
  if (!commit.root.deletes.includes("modules")) {
    commit.root.deletes.push("modules");
  }
}
