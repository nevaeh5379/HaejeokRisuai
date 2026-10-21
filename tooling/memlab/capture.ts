import { closeSync, openSync, writeSync } from "node:fs";
import type { CDPSession } from "@playwright/test";

/** Keep the same CDP session for all three snapshots so object IDs stay comparable. */
export async function captureSnapshot(session: CDPSession, file: string) {
  await session.send("HeapProfiler.collectGarbage");
  const usage = await session.send("Runtime.getHeapUsage");
  const fd = openSync(file, "wx");
  const writeChunk = ({ chunk }: { chunk: string }) => {
    // Synchronous writes apply backpressure instead of retaining a complete
    // snapshot (or an unbounded queue of chunks) in the Node heap.
    writeSync(fd, chunk);
  };
  session.on("HeapProfiler.addHeapSnapshotChunk", writeChunk);
  try {
    await session.send("HeapProfiler.takeHeapSnapshot", {
      reportProgress: false,
    });
  } finally {
    session.off("HeapProfiler.addHeapSnapshotChunk", writeChunk);
    closeSync(fd);
  }
  return usage;
}
