import type { RisuModule } from "../../process/modules";
import type { SqlCommit } from "../../storage/sql/sqlCommit";
import { snapshotFingerprint } from "./reactiveUtils";

export function buildModuleDelta(
  previous: RisuModule[],
  current: RisuModule[],
): NonNullable<SqlCommit["modules"]> {
  const previousById = new Map(previous.map((module) => [module.id, module]));
  const currentIds = new Set(current.map((module) => module.id));
  const previousOrder = previous.map((module) => module.id);
  const order = current.map((module) => module.id);

  return {
    upserts: current.flatMap((module, position) => {
      const old = previousById.get(module.id);
      if (old && snapshotFingerprint(old) === snapshotFingerprint(module)) {
        return [];
      }
      return [{ id: module.id, position, data: module }];
    }),
    deletes: previous
      .filter((module) => !currentIds.has(module.id))
      .map((module) => module.id),
    order:
      previousOrder.length !== order.length ||
      previousOrder.some((id, index) => id !== order[index])
        ? order
        : undefined,
  };
}
