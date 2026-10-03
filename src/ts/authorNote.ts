import type { Chat } from "./storage/database/schema";
import { requireChatTarget, type ChatTarget } from "./chatTarget";
import { characterStore } from "./stores/domain/characterStore.svelte";
import { globalAuthorNoteStore } from "./stores/domain/globalAuthorNoteStore";
import {
  AuthorNoteError,
  NO_AUTHOR_NOTE,
} from "@risuai/protocol/dist/authorNotes.cjs";

export type NoteSelection =
  { mode: "local" } | { mode: "global"; noteId: string };
class NoteSourceService {
  private constructor() {}
  static readonly instance = new NoteSourceService();
  get(chat: Chat): NoteSelection {
    return chat.globalAuthorNoteId === undefined
      ? { mode: "local" }
      : { mode: "global", noteId: chat.globalAuthorNoteId || NO_AUTHOR_NOTE };
  }
  async set(target: ChatTarget, source: NoteSelection): Promise<void> {
    requireChatTarget(target);
    if (
      source.mode === "global" &&
      !(await globalAuthorNoteStore.get(source.noteId))
    )
      throw new AuthorNoteError("missing", source.noteId);
    const { chat } = requireChatTarget(target);
    if (source.mode === "local") delete chat.globalAuthorNoteId;
    else chat.globalAuthorNoteId = source.noteId;
    characterStore.markChatDirty(target.chatId);
  }
}
export const NoteSource = NoteSourceService.instance;
export async function readNote(chat: Chat): Promise<string> {
  const source = NoteSource.get(chat);
  if (source.mode === "local") return chat.note ?? "";
  const note = await globalAuthorNoteStore.get(source.noteId);
  if (!note) return "";
  try {
    return await note.getContent();
  } catch (error) {
    if (error instanceof AuthorNoteError && error.code === "missing") return "";
    throw error;
  }
}
export function resolveNote(raw: string, templateDefault: string): string {
  return raw || templateDefault;
}
export async function materializeChatNote(chat: Chat): Promise<Chat> {
  const note = await readNote(chat);
  const exported = { ...chat, note };
  delete exported.globalAuthorNoteId;
  return exported;
}
