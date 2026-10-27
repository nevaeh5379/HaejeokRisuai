import type { RisuModule } from "@risuai/protocol/domain/modules.ts";
import type { SqlCommit } from "../../storage/sql/sqlCommit";
import { Sha256 } from "@aws-crypto/sha256-js";

/** Hash a single module without retaining its serialized body. */
export function fingerprintModule(module: RisuModule): string {
  const hash = new Sha256();
  hash.update(JSON.stringify(module));
  return Array.from(hash.digestSync(), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function sameModuleBaseline(
  previous: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): boolean {
  if (previous.size !== current.size) return false;
  const previousEntries = previous.entries();
  for (const [id, fingerprint] of current) {
    const entry = previousEntries.next().value;
    if (!entry || entry[0] !== id || entry[1] !== fingerprint) return false;
  }
  return true;
}

export function buildModuleDelta(
  previous: ReadonlyMap<string, string>,
  current: RisuModule[],
  baseline: ReadonlyMap<string, string>,
): NonNullable<SqlCommit["modules"]> {
  const previousOrder = [...previous.keys()];
  const order = [...baseline.keys()];

  return {
    upserts: current.flatMap((module, position) => {
      if (previous.get(module.id) === baseline.get(module.id)) {
        return [];
      }
      return [{ id: module.id, position, data: module }];
    }),
    deletes: previousOrder.filter((id) => !baseline.has(id)),
    order:
      previousOrder.length !== order.length ||
      previousOrder.some((id, index) => id !== order[index])
        ? order
        : undefined,
  };
}
