import {
  AuthorNoteError,
  hashAuthorNote,
} from "@risuai/protocol/src/authorNotes.ts";
import { applyAuthorNotes } from "@risuai/protocol/src/authorNoteSql.ts";
import { readNote, resolveNote } from "../../src/ts/authorNote";
import { globalAuthorNoteStore } from "../../src/ts/stores/domain/globalAuthorNoteStore";
import type { Chat } from "../../src/ts/storage/database/schema";
import type { ISqlStorage } from "../../src/ts/storage/sql/ISqlStorage";

export async function probeAuthorNoteBrowser() {
  let failure: Error = new AuthorNoteError("missing", "deleted");
  await globalAuthorNoteStore.init({
    getGlobalAuthorNote: async () => ({
      id: "deleted",
      name: "Deleted",
      updatedAt: 0,
    }),
    readGlobalAuthorNote: async () => {
      throw failure;
    },
  } as unknown as ISqlStorage);
  const chat = {
    note: "local retained",
    globalAuthorNoteId: "deleted",
  } as Chat;
  const missing = await readNote(chat);
  failure = new Error("SQL read failed");
  let sqlError = "";
  try {
    await readNote(chat);
  } catch (error) {
    sqlError = String(error);
  }
  let sharedErrorClass = false;
  try {
    await applyAuthorNotes(
      {
        dialect: "sqlite",
        query: async () => [],
        execute: async () => undefined,
      },
      [{ type: "remove", id: "deleted" }],
    );
  } catch (error) {
    sharedErrorClass = error instanceof AuthorNoteError;
  }
  await globalAuthorNoteStore.dispose();
  return {
    missing,
    fallback: resolveNote(missing, "template default"),
    sqlError,
    sharedErrorClass,
    hash: await hashAuthorNote(""),
  };
}
