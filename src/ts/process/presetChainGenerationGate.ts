import { Mutex } from "../mutex";

const presetChainGenerationMutex = new Mutex();

export async function runWithPresetChainGenerationGate<T>(
  enabled: boolean,
  callback: () => Promise<T>,
): Promise<T> {
  if (!enabled) return callback();
  return presetChainGenerationMutex.runExclusive(callback);
}
