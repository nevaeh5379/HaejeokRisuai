/** Serializes loading, replacement and encoding of a shared native tokenizer. */
export function createTokenizerQueue() {
  let tail: Promise<void> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const task = tail.then(work);
    tail = task.then(
      () => {},
      () => {},
    );
    return task;
  };
}
