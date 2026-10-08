/// <reference path="./version.d.ts" />
import { graphToPrompt } from "./upstream/src/utils/executionUtil";
import { WorkflowGraph, type ObjectInfo, type SerializedGraph } from "./graph";
export type { ObjectInfo } from "./graph";

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
