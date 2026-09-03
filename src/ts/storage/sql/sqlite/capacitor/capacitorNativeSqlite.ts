import { registerPlugin } from "@capacitor/core";

export interface NativeSqliteStatement {
  sql: string;
  bind?: unknown[];
}

export interface NativeSqlitePlugin {
  open(options: { database: string }): Promise<void>;
  close(): Promise<void>;
  query(options: {
    sql: string;
    bind?: unknown[];
  }): Promise<{ values: Record<string, unknown>[] }>;
  queryBatch(options: {
    queries: NativeSqliteStatement[];
  }): Promise<{ results: Record<string, unknown>[][] }>;
  beginTransaction(options: {
    expectedRevision?: number | null;
  }): Promise<{ id: string }>;
  executeBatch(options: {
    id: string;
    statements: NativeSqliteStatement[];
  }): Promise<{ statements: number }>;
  commitTransaction(options: { id: string }): Promise<void>;
  rollbackTransaction(options: { id: string }): Promise<void>;
  restoreOpen(options: { expectedRevision: number }): Promise<{ id: string }>;
  restoreAppend(options: { id: string; data: string }): Promise<void>;
  restoreFinish(options: { id: string }): Promise<{ statements: number }>;
  restoreAbort(options: { id: string }): Promise<void>;
  addListener(
    eventName: "restoreProgress",
    listener: (event: {
      id: string;
      completed: number;
      stage?: string;
    }) => void,
  ): Promise<{ remove(): Promise<void> }>;
}

export const nativeSqlite = registerPlugin<NativeSqlitePlugin>("NativeSqlite");
