const DEFAULT_BULK_READ_PREFETCH: any = 4;
const MAX_BULK_READ_PREFETCH: any = 8;

function normalizePrefetchConcurrency(value?: any): any {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_BULK_READ_PREFETCH;
  }

  const parsed: any = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_BULK_READ_PREFETCH;
  return Math.min(MAX_BULK_READ_PREFETCH, Math.max(1, parsed));
}

async function* prefetchInOrder(
  items?: any,
  load?: any,
  concurrency?: any,
): AsyncGenerator<any> {
  const values: any = Array.isArray(items) ? items : Array.from(items);
  const limit: any = normalizePrefetchConcurrency(concurrency);
  const pending: any = new Map();
  let nextToStart: any = 0;

  const start: any = (index?: any) => {
    const item: any = values[index];
    const result: any = Promise.resolve()
      .then(() => load(item))
      .then(
        (value?: any) => ({ item, value }),
        (error?: any) => ({ item, error }),
      );
    pending.set(index, result);
  };

  while (nextToStart < values.length && pending.size < limit) {
    start(nextToStart);
    nextToStart += 1;
  }

  for (let index: any = 0; index < values.length; index += 1) {
    const result: any = await pending.get(index);
    pending.delete(index);

    if (nextToStart < values.length) {
      start(nextToStart);
      nextToStart += 1;
    }

    yield result;
  }
}

export { normalizePrefetchConcurrency, prefetchInOrder };
