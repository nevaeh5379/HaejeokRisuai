import { describe, expect, it } from "vitest";
import { restoreBackupArchive } from "./restoreArchive";
import { LEGACY_DATABASE_ENTRY_NAME } from "./entryPolicy";
import { createBackupContainerEntryHeader } from "./containerStream";

function containerEntry(name: string, data: Uint8Array): Uint8Array {
  const header: Uint8Array = createBackupContainerEntryHeader(
    name,
    data.length,
  );
  const output: Uint8Array = new Uint8Array(header.length + data.length);
  output.set(header, 0);
  output.set(data, header.length);
  return output;
}

describe("restoreBackupArchive", (): void => {
  it("stages a legacy database and reports injected progress", async (): Promise<void> => {
    const database: Uint8Array = new Uint8Array([1, 2, 3]);
    const archive: Uint8Array = containerEntry(
      LEGACY_DATABASE_ENTRY_NAME,
      database,
    );
    const progress: number[] = [];
    const result = await restoreBackupArchive({
      source: {
        size: archive.length,
        stream(): ReadableStream<Uint8Array> {
          return new ReadableStream<Uint8Array>({
            start(
              controller: ReadableStreamDefaultController<Uint8Array>,
            ): void {
              controller.enqueue(archive);
              controller.close();
            },
          });
        },
        async arrayBuffer(): Promise<ArrayBuffer> {
          return archive.slice().buffer;
        },
      },
      createStreamSink: async () => null,
      decodeStreamValue: async (): Promise<unknown> => undefined,
      decodeRawDatabase: async (): Promise<unknown> => ({}),
      restoreInlay: async () => ({ status: "restored" }),
      restoreColdStorage: async () => true,
      restoreAsset: async (): Promise<void> => undefined,
      flushAssets: async (): Promise<void> => undefined,
      onProgress: ({ totalBytesRead }): void => {
        progress.push(totalBytesRead);
      },
    });

    expect(result.pendingDatabase).toEqual(database);
    expect(progress.at(-1)).toBe(archive.length);
  });
});
