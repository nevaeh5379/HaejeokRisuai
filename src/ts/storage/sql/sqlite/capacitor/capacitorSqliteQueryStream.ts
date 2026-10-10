import { Buffer } from "buffer";
import type {
  NativeSqlitePlugin,
  NativeSqliteStatement,
} from "./capacitorNativeSqlite";

/** Retains decoded rows, never a JSON string containing the entire result. */
export async function readSqliteQueryStream(
  plugin: NativeSqlitePlugin,
  queries: NativeSqliteStatement[],
): Promise<Record<string, unknown>[][]> {
  if (queries.length === 0) return [];
  const { id } = await plugin.queryStreamOpen({ queries });
  const results: Record<string, unknown>[][] = queries.map(() => []);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let queryIndex = 0;
  let fragments: string[] = [];
  let succeeded = false;

  const consume = (text: string) => {
    let start = 0;
    for (;;) {
      const end = text.indexOf("\n", start);
      if (end < 0) break;
      const tail = text.slice(start, end);
      const line = fragments.length ? [...fragments, tail].join("") : tail;
      fragments = [];
      const record = JSON.parse(line) as Record<string, unknown>;
      if (
        !record ||
        record.queryIndex !== queryIndex ||
        queryIndex >= queries.length
      )
        throw new Error("Invalid SQLite query stream order");
      if (record.type === "end") {
        queryIndex++;
      } else if (
        record.type === "row" &&
        record.row !== null &&
        typeof record.row === "object" &&
        !Array.isArray(record.row)
      ) {
        results[queryIndex].push(record.row as Record<string, unknown>);
      } else throw new Error("Invalid SQLite query stream record");
      start = end + 1;
    }
    if (start < text.length) fragments.push(text.slice(start));
  };

  try {
    for (;;) {
      const chunk = await plugin.queryStreamRead({ id });
      if (chunk.data.length > 256 * 1024) {
        throw new Error("SQLite query stream chunk exceeds transport limit");
      }
      if (!chunk.done && chunk.data.length === 0) {
        throw new Error("SQLite query stream made no progress");
      }
      consume(
        decoder.decode(Buffer.from(chunk.data, "base64"), { stream: true }),
      );
      if (chunk.done) break;
    }
    consume(decoder.decode());
    if (fragments.length || queryIndex !== queries.length) {
      throw new Error("Incomplete SQLite query stream");
    }
    succeeded = true;
    return results;
  } finally {
    try {
      await plugin.queryStreamClose({ id });
    } catch (error) {
      if (succeeded) throw error;
    }
  }
}
