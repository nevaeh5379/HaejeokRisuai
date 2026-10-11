import { graphToPrompt } from "./executionUtil";
import { WorkflowGraph } from "./graph";
import type { ObjectInfo, SerializedGraph } from "./types";
export type { ObjectInfo } from "./types";

export async function workflowToPrompt(value: unknown, info: ObjectInfo) {
  const graph = new WorkflowGraph(value as SerializedGraph, info);
  try {
    const { output } = await graphToPrompt(graph);
    if (!Object.keys(output).length)
      throw new Error("Workflow has no executable nodes.");
    return output;
  } finally {
    graph.dispose();
  }
}
