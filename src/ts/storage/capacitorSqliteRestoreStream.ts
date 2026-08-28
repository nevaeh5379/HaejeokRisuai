import { Buffer } from "buffer";

const TRANSPORT_BASE64_CHUNK = 256 * 1024;
const TRANSPORT_BYTE_CHUNK = Math.floor((TRANSPORT_BASE64_CHUNK - 1) / 4) * 3;
const JSON_STRING_SLICE = 16 * 1024;

import { nativeSqlite, type NativeSqlitePlugin } from "./capacitorNativeSqlite";

function safeSliceEnd(value: string, start: number, requestedEnd: number) {
  let end = Math.min(value.length, requestedEnd);
  if (end <= start || end >= value.length) return end;
  const left = value.charCodeAt(end - 1);
  const right = value.charCodeAt(end);
  if (left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff) {
    end--;
  }
  return end;
}

class ChunkSink {
  private readonly pending = new Uint8Array(TRANSPORT_BYTE_CHUNK);
  private pendingLength = 0;
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly id: string,
    private readonly plugin: NativeSqlitePlugin,
  ) {}

  async write(value: string) {
    const bytes = this.encoder.encode(value);
    let offset = 0;
    while (offset < bytes.length) {
      const remaining = TRANSPORT_BYTE_CHUNK - this.pendingLength;
      const copied = Math.min(remaining, bytes.length - offset);
      this.pending.set(bytes.subarray(offset, offset + copied), this.pendingLength);
      this.pendingLength += copied;
      offset += copied;
      if (this.pendingLength >= TRANSPORT_BYTE_CHUNK) await this.flush();
    }
  }

  async flush() {
    if (this.pendingLength === 0) return;
    const data = Buffer.from(
      this.pending.subarray(0, this.pendingLength),
    ).toString("base64");
    this.pendingLength = 0;
    await this.plugin.restoreAppend({ id: this.id, data });
  }
}

async function writeJsonString(
  sink: ChunkSink,
  value: string,
  onSourceCharacters?: (count: number) => void,
) {
  await sink.write('"');
  for (let offset = 0; offset < value.length;) {
    const end = safeSliceEnd(value, offset, offset + JSON_STRING_SLICE);
    const encoded = JSON.stringify(value.slice(offset, end)).slice(1, -1);
    await sink.write(encoded);
    onSourceCharacters?.(end - offset);
    offset = end;
  }
  if (value.length === 0) onSourceCharacters?.(1);
  await sink.write('"');
}

async function writeBindValue(
  sink: ChunkSink,
  value: unknown,
  onSourceCharacters?: (count: number) => void,
) {
  if (value === null || value === undefined) {
    await sink.write("null");
    onSourceCharacters?.(1);
    return;
  }
  if (typeof value === "string") {
    await writeJsonString(sink, value, onSourceCharacters);
    return;
  }
  if (typeof value === "boolean") {
    await sink.write(value ? "true" : "false");
    onSourceCharacters?.(1);
    return;
  }
  if (typeof value === "number") {
    await sink.write(Number.isFinite(value) ? String(value) : "null");
    onSourceCharacters?.(1);
    return;
  }
  throw new TypeError(`Unsupported native SQLite restore bind: ${typeof value}`);
}

export class CapacitorSqliteRestoreStream {
  private id: string | null = null;
  private sink: ChunkSink | null = null;
  private firstStatement = true;
  private progressListener: { remove(): Promise<void> } | null = null;

  constructor(
    private readonly plugin: NativeSqlitePlugin = nativeSqlite,
  ) {}

  async open(
    expectedRevision: number,
    onProgress?: (completed: number, stage?: string) => void,
  ) {
    const opened = await this.plugin.restoreOpen({ expectedRevision });
    this.id = opened.id;
    this.sink = new ChunkSink(opened.id, this.plugin);
    this.progressListener = await this.plugin.addListener(
      "restoreProgress",
      (event) => {
        if (event.id === opened.id) onProgress?.(event.completed, event.stage);
      },
    );
    await this.sink.write("[");
  }

  async writeStatement(
    sql: string,
    bind: unknown[] = [],
    onProgress?: (fraction: number) => void,
  ) {
    if (!this.sink || !this.id) throw new Error("Native SQLite restore stream is not open");
    const totalSourceCharacters = Math.max(
      1,
      Math.max(1, sql.length) +
        bind.reduce<number>(
          (total, value) =>
            total + (typeof value === "string" ? Math.max(1, value.length) : 1),
          0,
        ),
    );
    let processedSourceCharacters = 0;
    const advance = (count: number) => {
      processedSourceCharacters += count;
      onProgress?.(
        Math.min(1, processedSourceCharacters / totalSourceCharacters),
      );
    };

    if (!this.firstStatement) await this.sink.write(",");
    this.firstStatement = false;
    await this.sink.write('{"sql":');
    await writeJsonString(this.sink, sql, advance);
    await this.sink.write(',"bind":[');
    for (let index = 0; index < bind.length; index++) {
      if (index > 0) await this.sink.write(",");
      await writeBindValue(this.sink, bind[index], advance);
    }
    await this.sink.write("]}");
    onProgress?.(1);
  }

  async finish(): Promise<number> {
    if (!this.sink || !this.id) throw new Error("Native SQLite restore stream is not open");
    const id = this.id;
    try {
      await this.sink.write("]");
      await this.sink.flush();
      const result = await this.plugin.restoreFinish({ id });
      return result.statements;
    } finally {
      await this.cleanupListener();
      this.id = null;
      this.sink = null;
    }
  }

  async abort() {
    const id = this.id;
    this.id = null;
    this.sink = null;
    try {
      if (id) await this.plugin.restoreAbort({ id });
    } finally {
      await this.cleanupListener();
    }
  }

  private async cleanupListener() {
    const listener = this.progressListener;
    this.progressListener = null;
    if (listener) await listener.remove();
  }
}

export const CAPACITOR_SQLITE_RESTORE_TRANSPORT_CHUNK = TRANSPORT_BASE64_CHUNK;
