export interface SqliteStatement {
  sql: string;
  bind: unknown[];
}

export type SqliteSelectRows = <T extends Record<string, unknown>>(
  sql: string,
  bind?: unknown[],
) => Promise<T[]>;

export type SqliteSelectRowSets = (
  queries: SqliteStatement[],
) => Promise<Record<string, unknown>[][]>;

export type SqliteExecute = (
  sql: string,
  bind?: unknown[],
) => void | Promise<void>;

export type SqliteLoadNodeValue = (
  table: string,
  ownerWhere: string,
  bind: unknown[],
) => Promise<unknown>;
