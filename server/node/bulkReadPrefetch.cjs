const DEFAULT_BULK_READ_PREFETCH = 4;
const MAX_BULK_READ_PREFETCH = 8;

function normalizePrefetchConcurrency(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_BULK_READ_PREFETCH;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_BULK_READ_PREFETCH;
  return Math.min(MAX_BULK_READ_PREFETCH, Math.max(1, parsed));
}

async function* prefetchInOrder(items, load, concurrency) {
  const values = Array.isArray(items) ? items : Array.from(items);
  const limit = normalizePrefetchConcurrency(concurrency);
  const pending = new Map();
  let nextToStart = 0;

  const start = (index) => {
    const item = values[index];
    const result = Promise.resolve()
      .then(() => load(item))
      .then(
        (value) => ({ item, value }),
        (error) => ({ item, error }),
      );
    pending.set(index, result);
  };

  while (nextToStart < values.length && pending.size < limit) {
    start(nextToStart);
    nextToStart += 1;
  }

  for (let index = 0; index < values.length; index += 1) {
    const result = await pending.get(index);
    pending.delete(index);

    if (nextToStart < values.length) {
      start(nextToStart);
      nextToStart += 1;
    }

    yield result;
  }
}

module.exports = {
  normalizePrefetchConcurrency,
  prefetchInOrder,
};
