export function reactiveDatabase<T>(value: T): T {
  const database = $state(value);
  return database;
}

export function legacyDatabaseSnapshot(
  database: Record<string, unknown>,
  keys: string[],
) {
  const result: Record<string, unknown> = {};
  for (const key of keys) result[key] = $state.snapshot(database[key]);
  return structuredClone(result);
}
