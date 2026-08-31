/**
 * Shared commit machinery for domain stores: debounced flush scheduling and
 * strictly-ordered write chaining.
 *
 * A store marks itself dirty on mutation, calls {@linkcode schedule} with its
 * flush callback, and awaits {@linkcode enqueue} inside `flush()` so commits
 * reach storage in call order even when callers fire concurrently. Failure
 * isolation matters: one failed commit must not poison the chain for later
 * writes, so enqueued callbacks are always invoked and errors surface only
 * to the awaiting caller.
 */
export class StoreCommitQueue {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();

  schedule(run: () => Promise<void>, delayMs = 100): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      void run().catch((error) => {
        console.error("[StoreCommitQueue] Scheduled flush failed:", error);
      });
    }, delayMs);
  }

  /** Serialise runs so two overlapping flushes never interleave storage writes. */
  enqueue<T>(run: () => Promise<T>): Promise<T> {
    const operation = this.chain.then(run, run);
    this.chain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  reset(): void {
    this.cancel();
    this.chain = Promise.resolve();
  }
}