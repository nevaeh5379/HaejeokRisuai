import {
  illustrationSourceHash,
  type Illustration,
  type IllustrationMessage,
} from "@risuai/protocol/src/illustration.ts";

/** Merges one committed slot without fetching/replacing the whole chat or reverting a newer snapshot. */
export function applyIllustrationProgress(
  message: IllustrationMessage,
  incoming: Illustration,
  branchId?: string,
): boolean {
  const index =
    message.illustrations?.findIndex((item) => item.id === incoming.id) ?? -1;
  if (index < 0) return false;
  const current = message.illustrations![index];
  if (
    incoming.version < current.version ||
    incoming.branchId !== branchId ||
    incoming.sourceHash !== illustrationSourceHash(message) ||
    message.data.split(current.token).length !== 2
  )
    return false;
  if (incoming.version === current.version) {
    if ((incoming.progress ?? 0) < (current.progress ?? 0)) return false;
    const images = new Set([
      ...(incoming.imageIds ?? []),
      ...(incoming.imageId ? [incoming.imageId] : []),
    ]);
    if (
      [
        ...(current.imageIds ?? []),
        ...(current.imageId ? [current.imageId] : []),
      ].some((id) => !images.has(id))
    )
      return false;
  }
  message.data = message.data.replace(current.token, incoming.token);
  message.illustrations![index] = incoming;
  return true;
}

/** Keeps a delayed full-chat hydration from undoing a slot already updated by its commit signal. */
export function preserveIllustrationProgress(
  current: IllustrationMessage[],
  incoming: IllustrationMessage[],
  branchId?: string,
): void {
  const resident = new Map(
    current
      .filter((message) => message.chatId && message.illustrations?.length)
      .map((message) => [message.chatId, message]),
  );
  for (const message of incoming) {
    const previous = resident.get(message.chatId);
    if (!previous) continue;
    const sourceHash = illustrationSourceHash(previous);
    for (const item of previous.illustrations ?? []) {
      if (
        item.executor === "server" &&
        item.progress &&
        item.sourceHash === sourceHash
      ) {
        applyIllustrationProgress(message, item, branchId);
      }
    }
  }
}
