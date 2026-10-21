import { describe, expect, it, vi } from "vitest";
import {
  AuthorNoteEditor,
  flushAuthorNoteEditors,
  hasUnsavedAuthorNoteDrafts,
  failedAuthorNoteDrafts,
} from "./authorNoteEditor";
import { get } from "svelte/store";

function createMockNote(initial = "") {
  let content = initial;
  return {
    getContent: vi.fn(async () => content),
    setContent: vi.fn(async (next: string) => {
      content = next;
    }),
  };
}

describe("AuthorNoteEditor", () => {
  it("tracks unsaved changes and flushes through iteration helpers", async () => {
    expect(hasUnsavedAuthorNoteDrafts()).toBe(false);

    const mockNote = createMockNote("initial text");
    const editor = new AuthorNoteEditor(mockNote as any);
    await editor.load();

    expect(editor.isReady).toBe(true);
    expect(hasUnsavedAuthorNoteDrafts()).toBe(false);

    editor.input("updated text");
    expect(hasUnsavedAuthorNoteDrafts()).toBe(true);

    await flushAuthorNoteEditors();
    expect(hasUnsavedAuthorNoteDrafts()).toBe(false);
    expect(mockNote.setContent).toHaveBeenCalledWith("updated text", {
      force: false,
    });

    editor.discard();
    expect(hasUnsavedAuthorNoteDrafts()).toBe(false);
  });

  it("updates failedAuthorNoteDrafts on detached errors without array spread", async () => {
    const errorNote = {
      getContent: vi.fn(async () => "note"),
      setContent: vi.fn(async () => {
        throw new Error("Conflict");
      }),
    };
    const editor = new AuthorNoteEditor(errorNote as any);
    await editor.load();

    editor.input("will fail");
    await editor.detach();

    expect(editor.detached).toBe(true);
    expect(editor.error).toBeInstanceOf(Error);
    const failed = get(failedAuthorNoteDrafts);
    expect(failed).toContain(editor);

    editor.discard();
    expect(get(failedAuthorNoteDrafts)).not.toContain(editor);
  });
});
