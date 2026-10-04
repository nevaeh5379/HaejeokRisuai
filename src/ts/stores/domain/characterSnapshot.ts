import isEqual from "lodash/isEqual";
import type { Chat } from "../../storage/database/schema";
import {
  sqlChatData,
  sqlMessageData,
  type SqlCommit,
} from "../../storage/sql/sqlCommit";

// Only deletion/manifest diffs and resident-window bounds live here; the
// Store owns target resolution, cloning, loading, validation, and commits.
export const snapshotEqual = isEqual;

export function diffSnapshotIds(ids: string[], oldIds: string[]) {
  if (snapshotEqual(ids, oldIds)) return null;
  const retained = new Set(ids);
  return { ids, removed: oldIds.filter((id) => !retained.has(id)) };
}

export function appendChatSnapshotChanges(
  commit: SqlCommit,
  characterId: string,
  position: number,
  next: Chat,
  old?: Chat,
): void {
  // Snapshot saves rewrite their full scope unconditionally. `old` is only
  // the deletion baseline: it tells which stored messages the complete
  // input no longer contains.
  commit.chats.push({
    id: next.id!,
    characterId,
    position,
    data: sqlChatData(next),
  });
  for (const [index, message] of next.message.entries()) {
    commit.messages.push({
      id: message.chatId!,
      chatId: next.id!,
      position: index,
      data: sqlMessageData(message),
    });
  }
  const ids = next.message.map((message) => message.chatId!);
  const oldIds = old?.message.map((message) => message.chatId!) ?? [];
  const changes = diffSnapshotIds(ids, oldIds);
  if (changes) {
    commit.messageManifests.push({ chatId: next.id!, ids: changes.ids });
    if (changes.removed.length)
      commit.messageDeletes!.push({ chatId: next.id!, ids: changes.removed });
  }
}

export function keepResidentWindow(next: Chat, previous?: Chat): Chat {
  if (
    !previous ||
    (previous.messagesLoaded !== false &&
      previous.messagesFullyLoaded !== false)
  )
    return next;
  const total = next.message.length;
  if (previous.messagesLoaded === false) {
    return {
      ...next,
      message: [],
      messagesLoaded: false,
      messagesFullyLoaded: false,
      messageTotal: total,
    };
  }
  const count = previous.message.length;
  const atEnd =
    (previous.messageOffset ?? 0) + count >= (previous.messageTotal ?? 0);
  const offset = atEnd
    ? Math.max(0, total - count)
    : Math.min(previous.messageOffset ?? 0, Math.max(0, total - count));
  const message = next.message.slice(offset, offset + count);
  return {
    ...next,
    message,
    messageOffset: offset,
    messageTotal: total,
    messagesFullyLoaded: message.length === total,
  };
}
