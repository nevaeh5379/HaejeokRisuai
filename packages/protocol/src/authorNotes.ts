import { Sha256 } from "@aws-crypto/sha256-js";

export const NO_AUTHOR_NOTE = "__none__";
export const EMPTY_AUTHOR_NOTE_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** Serialization rows only; never used as the runtime note object. */
export interface AuthorNoteRow {
  id: string;
  name: string;
  content: string;
  contentHash: string;
  updatedAt: number;
}
export type AuthorNoteMetadata = Omit<AuthorNoteRow, "content" | "contentHash">;
export type AuthorNoteOperation =
  | { type: "create"; id: string; name: string; content: string }
  | { type: "rename"; id: string; name: string }
  | {
      type: "content";
      id: string;
      content: string;
      expectedHash: string | null;
      force?: boolean;
      script?: boolean;
    }
  | { type: "remove"; id: string }
  | { type: "settings"; allowScriptWrite: boolean }
  | {
      type: "restore";
      rows: AuthorNoteRow[];
      allowScriptWrite: boolean;
      clear?: boolean;
    };
export class AuthorNoteError extends Error {
  readonly code:
    | "missing"
    | "conflict"
    | "protected"
    | "unread"
    | "script-blocked"
    | "disposed";
  readonly noteId?: string;
  constructor(
    code:
      | "missing"
      | "conflict"
      | "protected"
      | "unread"
      | "script-blocked"
      | "disposed",
    noteId?: string,
  ) {
    super(`author-note:${code}${noteId ? `:${noteId}` : ""}`);
    this.code = code;
    this.noteId = noteId;
    this.name = "AuthorNoteError";
  }
}
export async function hashAuthorNote(content: string): Promise<string> {
  const hash = new Sha256();
  hash.update(new TextEncoder().encode(content));
  return Array.from(await hash.digest(), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export function parseAuthorNoteOperations(
  value: unknown,
): AuthorNoteOperation[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("authorNotes must be an array");
  return value.map((raw): AuthorNoteOperation => {
    if (!raw || typeof raw !== "object")
      throw new Error("Invalid author note operation");
    const row = raw as Record<string, unknown>;
    if (row.type === "settings") {
      if (typeof row.allowScriptWrite !== "boolean")
        throw new Error("Invalid author note setting");
      return { type: "settings", allowScriptWrite: row.allowScriptWrite };
    }
    if (row.type === "restore") {
      if (!Array.isArray(row.rows) || typeof row.allowScriptWrite !== "boolean")
        throw new Error("Invalid author note restore");
      const ids = new Set<string>();
      const rows = row.rows.map((entry): AuthorNoteRow => {
        if (
          !entry ||
          typeof entry.id !== "string" ||
          !entry.id ||
          entry.id.length > 128 ||
          typeof entry.name !== "string" ||
          typeof entry.content !== "string" ||
          !Number.isSafeInteger(entry.updatedAt) ||
          entry.updatedAt < 0 ||
          ids.has(entry.id)
        )
          throw new Error("Invalid author note restore row");
        ids.add(entry.id);
        return {
          id: entry.id,
          name: entry.name,
          content: entry.content,
          contentHash: entry.contentHash,
          updatedAt: entry.updatedAt,
        };
      });
      return {
        type: "restore",
        rows,
        allowScriptWrite: row.allowScriptWrite,
        clear: row.clear === false ? false : true,
      };
    }
    if (typeof row.id !== "string" || !row.id || row.id.length > 128)
      throw new Error("Invalid author note id");
    if (row.id === NO_AUTHOR_NOTE)
      throw new AuthorNoteError("protected", row.id);
    switch (row.type) {
      case "remove":
        return { type: "remove", id: row.id };
      case "create":
        if (typeof row.content !== "string" || typeof row.name !== "string")
          throw new Error("Invalid author note create");
        return {
          type: "create",
          id: row.id,
          name: row.name,
          content: row.content,
        };
      case "rename":
        if (typeof row.name !== "string")
          throw new Error("Invalid author note name");
        return { type: "rename", id: row.id, name: row.name };
      case "content":
        if (
          typeof row.content !== "string" ||
          (row.expectedHash !== null &&
            (typeof row.expectedHash !== "string" ||
              !/^[a-f0-9]{64}$/.test(row.expectedHash))) ||
          (row.force !== undefined && typeof row.force !== "boolean") ||
          (row.script !== undefined && typeof row.script !== "boolean")
        )
          throw new Error("Invalid author note content");
        return {
          type: "content",
          id: row.id,
          content: row.content,
          expectedHash: row.expectedHash as string | null,
          force: row.force as boolean | undefined,
          script: row.script as boolean | undefined,
        };
      default:
        throw new Error("Unknown author note operation");
    }
  });
}
