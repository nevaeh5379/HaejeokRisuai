import type { SnapshotOperation, SnapshotValue } from "./databaseTransfer";

export const DATABASE_BATCH_OPERATIONS = 256;
const DATABASE_BATCH_TEXT_UNITS = 64 * 1024;

// Host-only envelope. Ordinary arrays/objects are traversed, not deep-copied.
// Plain data uses bounded batches. Opaque native leaves are cloned together to
// preserve their shared children; the final graph is assembled in the iframe.
export class DatabaseSnapshotTransfer {
  constructor(
    private source:
      | (() => Iterable<{
          key: string;
          read: () => unknown;
          asynchronous: boolean;
        }>)
      | undefined,
  ) {}

  async send(post: (operations: SnapshotOperation[]) => void): Promise<void> {
    const source = this.source;
    this.source = undefined;
    if (!source) throw new Error("Database snapshot already transferred");
    let batch: SnapshotOperation[] = [];
    let textUnits = 0;
    let nextId = 0;
    const nativeOperations: SnapshotOperation[] = [];
    const flush = () => {
      if (!batch.length) return;
      const operations = batch;
      batch = [];
      textUnits = 0;
      post(operations);
    };
    const emit = (operation: SnapshotOperation) => {
      batch.push(operation);
      if (operation[0] === "set") {
        textUnits += typeof operation[2] === "string" ? operation[2].length : 0;
        if (operation[3][0] === 0 && typeof operation[3][1] === "string")
          textUnits += operation[3][1].length;
      } else if (
        operation[0] === "root" &&
        operation[2][0] === 0 &&
        typeof operation[2][1] === "string"
      ) {
        textUnits += operation[2][1].length;
      }
      if (
        batch.length >= DATABASE_BATCH_OPERATIONS ||
        textUnits >= DATABASE_BATCH_TEXT_UNITS
      )
        flush();
    };

    // Traverse each key synchronously. Await only the existing lazy plugin load,
    // at its original position in allowedKeys, preserving legacy read timing.
    for (const entry of source()) {
      const key = entry.key;
      const root = entry.asynchronous ? await entry.read() : entry.read();
      const cloned = new WeakMap<object, number>();
      const encode = (
        value: any,
        original: object | null = null,
        topLevel = false,
      ): SnapshotValue => {
        if (typeof value === "object" && value !== null) {
          const previous = cloned.get(value);
          if (previous !== undefined) return [1, previous];
          if (!(value instanceof Map) && !(value instanceof Set)) {
            if (Array.isArray(value)) {
              const id = nextId++;
              cloned.set(value, id);
              if (original !== null) cloned.set(original, id);
              emit(["array", id, value.length]);
              for (let i = 0; i < value.length; i++) {
                const element = value[i];
                if (i in value) emit(["set", id, i, encode(element)]);
              }
              return [1, id];
            }
            if (Object.getPrototypeOf(value) === Object.prototype) {
              const id = nextId++;
              cloned.set(value, id);
              if (original !== null) cloned.set(original, id);
              emit(["object", id]);
              for (const property of Object.keys(value))
                emit(["set", id, property, encode(value[property])]);
              return [1, id];
            }
            // Match Svelte's snapshot conversion for class instances, including
            // references from a toJSON result back to its original instance.
            if (
              !(value instanceof Date) &&
              typeof value.toJSON === "function"
            ) {
              return encode(value.toJSON(), value, topLevel);
            }
          }
          const id = nextId++;
          // Native structured-clone types retain Svelte's existing semantics.
          // Plain character/chat/message graphs never take this fallback.
          nativeOperations.push([
            topLevel ? "rootNative" : "native",
            id,
            $state.snapshot(value),
          ]);
          return [1, id];
        }
        return [0, value];
      };
      emit(["root", key, encode(root, null, true)]);
      flush();
    }
    // Map/Set snapshots retain raw child references, even across allowed keys.
    // Clone opaque leaves together to preserve their native identity relations.
    if (nativeOperations.length) post(nativeOperations);
  }
}

export function prepareDatabaseSnapshot(
  database: Record<string, unknown>,
  allowedKeys: string[],
  loadPlugins: () => Promise<unknown>,
  includeOnly: string[] | "all" = "all",
): DatabaseSnapshotTransfer {
  const keys = allowedKeys.filter(
    (key) => includeOnly === "all" || includeOnly.includes(key),
  );
  return new DatabaseSnapshotTransfer(function* () {
    for (const key of keys)
      yield {
        key,
        read: key === "plugins" ? loadPlugins : () => database[key],
        asynchronous: key === "plugins",
      };
  });
}
