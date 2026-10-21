import type { RisuModule } from "../../process/modules";
import type { SqlCommit } from "../../storage/sql/sqlCommit";
import isEqual from "lodash/isEqual";

export function buildModuleDelta(
  previous: RisuModule[],
  current: RisuModule[],
): NonNullable<SqlCommit["modules"]> {
  const previousById = new Map<string, RisuModule>();
  for (const module of previous) {
    previousById.set(module.id, module);
  }
  const currentIds = new Set<string>();
  const order: string[] = [];
  for (const module of current) {
    currentIds.add(module.id);
    order.push(module.id);
  }

  const deletes: string[] = [];
  for (const module of previous) {
    if (!currentIds.has(module.id)) {
      deletes.push(module.id);
    }
  }

  let orderChanged = previous.length !== current.length;
  if (!orderChanged) {
    for (let i = 0; i < previous.length; i++) {
      if (previous[i].id !== current[i].id) {
        orderChanged = true;
        break;
      }
    }
  }

  return {
    upserts: current.flatMap((module, position) => {
      const old = previousById.get(module.id);
      if (old && isEqual(old, module)) {
        return [];
      }
      return [{ id: module.id, position, data: module }];
    }),
    deletes,
    order: orderChanged ? order : undefined,
  };
}
