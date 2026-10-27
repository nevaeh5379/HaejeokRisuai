import { describe, expect, it } from "vitest";
import { NoteSource, materializeChatNote, resolveNote } from "./authorNote";
import type { Chat } from "@risuai/protocol/domain/database.ts";

describe("authorNote", () => {
  it("resolves note with fallback", () => {
    expect(resolveNote("Custom Note", "Default")).toBe("Custom Note");
    expect(resolveNote("", "Default")).toBe("Default");
  });

  it("determines NoteSource mode correctly", () => {
    const localChat: Chat = {
      message: [],
      name: "Local Chat",
      note: "Local note content",
      localLore: [],
    };
    expect(NoteSource.get(localChat)).toEqual({ mode: "local" });

    const globalChat: Chat = {
      message: [],
      name: "Global Chat",
      note: "",
      localLore: [],
      globalAuthorNoteId: "note-123",
    };
    expect(NoteSource.get(globalChat)).toEqual({
      mode: "global",
      noteId: "note-123",
    });
  });

  it("materializes local chat notes and strips globalAuthorNoteId", async () => {
    const chat: Chat = {
      message: [],
      name: "Test Chat",
      note: "My local note",
      localLore: [],
    };
    const materialized = await materializeChatNote(chat);
    expect(materialized.name).toBe("Test Chat");
    expect(materialized.note).toBe("My local note");
    expect("globalAuthorNoteId" in materialized).toBe(false);
  });
});
