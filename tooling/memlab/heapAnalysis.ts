import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ConsoleMode,
  findLeaksBySnapshotFilePaths,
  getFullHeapFromFile,
} from "@memlab/api";

export interface HeapSummary {
  nodeCount: number;
  edgeCount: number;
  shallowBytes: number;
  detachedNodeCount: number;
  types: Record<string, { count: number; shallowBytes: number }>;
  largestRetainers: {
    id: number;
    type: string;
    name: string;
    shallowBytes: number;
    retainedBytes: number;
  }[];
}

/** Analyze a Chrome/Node snapshot with MemLab's parser and dominator analysis. */
export async function summarizeSnapshot(
  file: string,
  top = 20,
): Promise<HeapSummary> {
  const heap = await getFullHeapFromFile(file);
  const result: HeapSummary = {
    nodeCount: heap.nodes.length,
    edgeCount: heap.edges.length,
    shallowBytes: 0,
    detachedNodeCount: 0,
    types: {},
    largestRetainers: [],
  };
  heap.nodes.forEach((node) => {
    result.shallowBytes += node.self_size;
    if (node.is_detached) result.detachedNodeCount++;
    const group = (result.types[node.type] ??= { count: 0, shallowBytes: 0 });
    group.count++;
    group.shallowBytes += node.self_size;

    // String names contain application data. Include their bytes in totals,
    // but keep their contents out of the summary and console table.
    if (
      node.type.includes("string") ||
      node.type === "synthetic" ||
      node.retainedSize === 0 ||
      (result.largestRetainers.length === top &&
        node.retainedSize <= result.largestRetainers.at(-1)!.retainedBytes)
    )
      return;
    result.largestRetainers.push({
      id: node.id,
      type: node.type,
      name: node.name.slice(0, 160),
      shallowBytes: node.self_size,
      retainedBytes: node.retainedSize,
    });
    result.largestRetainers.sort((a, b) => b.retainedBytes - a.retainedBytes);
    result.largestRetainers.length = Math.min(
      top,
      result.largestRetainers.length,
    );
  });
  return result;
}

/** Compare three captures from the same page, without navigating/reloading it. */
export async function findSnapshotLeaks(
  snapshots: { baseline: string; target: string; final: string },
  workDir: string,
) {
  await mkdir(workDir, { recursive: true });
  const leaks = await findLeaksBySnapshotFilePaths(
    snapshots.baseline,
    snapshots.target,
    snapshots.final,
    { workDir, consoleMode: ConsoleMode.SILENT },
  );
  return { leakClusters: leaks.length };
}

export async function writeReport(
  file: string,
  report: unknown,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(report, null, 2) + "\n");
}
