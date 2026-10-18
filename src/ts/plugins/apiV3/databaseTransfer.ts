export type SnapshotValue = [0, unknown] | [1, number];
export type SnapshotOperation =
  | ["object", number]
  | ["array", number, number]
  | ["native" | "rootNative", number, unknown]
  | ["stream", number, number]
  | ["set", number, string | number, SnapshotValue]
  | ["root", string, SnapshotValue];

// Self-contained: this function is embedded in the sandbox's nonce script.
// Keep all runtime dependencies inside it, including after production minification.
export function createDatabaseSnapshotReceiver() {
  const nodes = new Map<number, any>();
  const waiting = new Map<number, { target: any; key: string | number }[]>();
  let result: Record<string, unknown> = {};
  const value = (encoded: SnapshotValue): unknown => {
    if (encoded[0] === 0) return encoded[1];
    if (!nodes.has(encoded[1]))
      throw new Error("Missing database snapshot node");
    return nodes.get(encoded[1]);
  };
  const assign = (
    target: any,
    key: string | number,
    encoded: SnapshotValue,
  ) => {
    if (key === "__proto__") return;
    if (encoded[0] === 1 && !nodes.has(encoded[1])) {
      // Reserve the original property position while native leaves are in flight.
      target[key] = undefined;
      let slots = waiting.get(encoded[1]);
      if (!slots) {
        slots = [];
        waiting.set(encoded[1], slots);
      }
      slots.push({ target, key });
    } else target[key] = value(encoded);
  };
  return {
    apply(operations: SnapshotOperation[]) {
      for (const operation of operations) {
        switch (operation[0]) {
          case "object":
            nodes.set(operation[1], {});
            break;
          case "array":
            nodes.set(operation[1], new Array(operation[2]));
            break;
          case "native":
            nodes.set(operation[1], operation[2]);
            for (const slot of waiting.get(operation[1]) ?? [])
              slot.target[slot.key] = operation[2];
            waiting.delete(operation[1]);
            break;
          case "set": {
            const target = nodes.get(operation[1]);
            if (!target) throw new Error("Missing database snapshot target");
            // Svelte snapshots assign plain-object keys to {}. __proto__ is not
            // an own property after that assignment or the subsequent native clone.
            assign(target, operation[2], operation[3]);
            break;
          }
          case "root":
            assign(result, operation[1], operation[2]);
            break;
          default:
            throw new Error("Invalid database snapshot operation");
        }
      }
    },
    finish() {
      if (waiting.size)
        throw new Error("Incomplete database snapshot transfer");
      const snapshot = result;
      result = {};
      nodes.clear();
      waiting.clear();
      return snapshot;
    },
    abort() {
      result = {};
      nodes.clear();
      waiting.clear();
    },
  };
}
