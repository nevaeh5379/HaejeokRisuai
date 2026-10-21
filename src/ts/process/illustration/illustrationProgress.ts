import {
  illustrationSourceHash,
  type Illustration,
  type IllustrationMessage,
} from "@risuai/protocol/src/illustration.ts";

function hasSingleTokenOccurrence(text: string, token: string): boolean {
  const first = text.indexOf(token);
  if (first === -1) return false;
  return text.indexOf(token, first + token.length) === -1;
}

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
    !hasSingleTokenOccurrence(message.data, current.token)
  )
    return false;
  if (incoming.version === current.version) {
    if ((incoming.progress ?? 0) < (current.progress ?? 0)) return false;
    const images = new Set(incoming.imageIds);
    if (incoming.imageId) images.add(incoming.imageId);
    if (current.imageIds) {
      for (let i = 0; i < current.imageIds.length; i++) {
        if (!images.has(current.imageIds[i])) return false;
      }
    }
    if (current.imageId && !images.has(current.imageId)) {
      return false;
    }
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
  const resident = new Map<string, IllustrationMessage>();
  for (let i = 0; i < current.length; i++) {
    const message = current[i];
    if (message.chatId && message.illustrations?.length) {
      resident.set(message.chatId, message);
    }
  }
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
