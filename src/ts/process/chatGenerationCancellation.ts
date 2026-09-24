type LocalGeneration = {
  controller: AbortController;
  lifecycleId: () => string | undefined;
};

const localGenerations = new Map<string, LocalGeneration>();

export function registerLocalGeneration(
  chatId: string,
  controller: AbortController,
  lifecycleId: () => string | undefined,
): () => void {
  const generation = { controller, lifecycleId };
  localGenerations.set(chatId, generation);
  return () => {
    if (localGenerations.get(chatId) === generation)
      localGenerations.delete(chatId);
  };
}

export function cancelLocalGeneration(
  chatId: string,
  lifecycleId: string,
): boolean {
  const generation = localGenerations.get(chatId);
  if (!generation || generation.lifecycleId() !== lifecycleId) return false;
  generation.controller.abort();
  return true;
}
