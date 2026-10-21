import { describe, expect, it } from "vitest";
import {
  EMPTY_AUTHOR_NOTE_HASH,
  hashAuthorNote,
  parseAuthorNoteOperations,
} from "./authorNotes.ts";

describe("authorNotes optimization", () => {
  it("produces standard sha256 hex digest for empty string", async () => {
    const hash = await hashAuthorNote("");
    expect(hash).toBe(EMPTY_AUTHOR_NOTE_HASH);
  });

  it("produces consistent hex digest across multiple calls and payloads", async () => {
    const hash1 = await hashAuthorNote("Hello world");
    const hash2 = await hashAuthorNote("Hello world");
    expect(hash1).toBe(hash2);
    expect(hash1).toBe(
      "64ec88ca00b268e5ba1a35678a1b5316d212f4f366b2477232534a8aeca37f3c",
    );
  });

  it("parses author note operations into pre-allocated array", () => {
    const operations = parseAuthorNoteOperations([
      { type: "create", id: "note-1", name: "Note 1", content: "Content 1" },
      { type: "rename", id: "note-1", name: "Renamed Note" },
      { type: "remove", id: "note-1" },
      { type: "settings", allowScriptWrite: true },
      {
        type: "restore",
        allowScriptWrite: false,
        rows: [
          {
            id: "note-2",
            name: "Note 2",
            content: "Content 2",
            contentHash: "hash2",
            updatedAt: 12345,
          },
        ],
      },
    ]);
    expect(operations).toHaveLength(5);
    expect(operations?.[0]).toEqual({
      type: "create",
      id: "note-1",
      name: "Note 1",
      content: "Content 1",
    });
    expect(operations?.[3]).toEqual({
      type: "settings",
      allowScriptWrite: true,
    });
    expect(operations?.[4].type).toBe("restore");
  });
});
