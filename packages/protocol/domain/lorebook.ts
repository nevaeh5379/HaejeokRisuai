import type { loreBook } from "./database.ts";

/** A global lorebook. `loreBook` describes one entry, not the containing book.
 * Existing global books are addressed by their persisted array position, not a stable ID. */
export interface LorebookFields {
  position: number;
  name: string;
  data: loreBook[];
}

export type LorebookUpdate = Partial<Pick<LorebookFields, "name" | "data">>;
