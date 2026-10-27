import isEqual from "lodash/isEqual";
import type { Chat } from "@risuai/protocol/domain/database.ts";
import {
  sqlChatData,
  sqlMessageData,
  type SqlCommit,
} from "../../storage/sql/sqlCommit";

// Only deletion/manifest diffs and resident-window bounds live here; the
// Store owns target resolution, cloning, loading, validation, and commits.
export const snapshotEqual = isEqual;

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function diffSnapshotIds(ids: string[], oldIds: string[]) {
  if (arraysEqual(ids, oldIds)) return null;
  const retained = new Set(ids);
  const removed: string[] = [];
  for (let i = 0; i < oldIds.length; i++) {
    const id = oldIds[i];
    if (!retained.has(id)) {
      removed.push(id);
    }
  }
  return { ids, removed };
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

  const nextMessages = next.message;
  const ids = new Array<string>(nextMessages.length);
  for (let index = 0; index < nextMessages.length; index++) {
    const message = nextMessages[index];
    const msgId = message.chatId!;
    ids[index] = msgId;
    commit.messages.push({
      id: msgId,
      chatId: next.id!,
      position: index,
      data: sqlMessageData(message),
    });
  }

  const oldMessages = old?.message;
  let oldIds: string[];
  if (oldMessages && oldMessages.length > 0) {
    oldIds = new Array<string>(oldMessages.length);
    for (let i = 0; i < oldMessages.length; i++) {
      oldIds[i] = oldMessages[i].chatId!;
    }
  } else {
    oldIds = [];
  }

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
