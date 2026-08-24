export interface SqliteTransactionStatement {
  sql: string;
  bind: unknown[];
}

export class AsyncSerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function normalizeSqliteLimit(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

export function normalizeSqlitePageEnd(
  before: number | undefined,
  total: number,
): number {
  if (before === undefined || !Number.isFinite(before)) return total;
  return Math.min(total, Math.max(0, Math.floor(before)));
}
