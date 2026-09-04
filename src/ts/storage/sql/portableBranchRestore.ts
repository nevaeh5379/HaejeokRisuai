import type { Message } from "../database/schema";
import type {
  PortableBranchGraph,
  PortableBranchGraphMap,
} from "@risuai/backup-core/portableBranches.cjs";
import { portableBranchPath } from "@risuai/backup-core/portableBranches.cjs";
import { createEmptySqlCommit, sqlMessageData } from "./sqlCommit";
import type { SqlBranchStorage } from "./sqlStorageFactory";

function sourceRoot(graph: PortableBranchGraph) {
  const ids = new Set(graph.branches.map((branch) => branch.id));
  return (
    graph.branches.find((branch) => branch.reason === "root") ??
    graph.branches.find(
      (branch) => !branch.parentBranchId || !ids.has(branch.parentBranchId),
    ) ??
    graph.branches[0]
  );
}

function parentFirstBranches(graph: PortableBranchGraph) {
  const byId = new Map(graph.branches.map((branch) => [branch.id, branch]));
  const ordered: PortableBranchGraph["branches"] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (branch: PortableBranchGraph["branches"][number]) => {
    if (visited.has(branch.id) || visiting.has(branch.id)) return;
    visiting.add(branch.id);
    if (branch.parentBranchId) {
      const parent = byId.get(branch.parentBranchId);
      if (parent) visit(parent);
    }
    visiting.delete(branch.id);
    visited.add(branch.id);
    ordered.push(branch);
  };
  [...graph.branches]
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
    .forEach(visit);
  return ordered;
}

export async function restorePortableChatBranchGraph(
  storage: SqlBranchStorage,
  chatId: string,
  graph: PortableBranchGraph,
): Promise<void> {
  if (!Array.isArray(graph.branches) || graph.branches.length <= 1) return;
  const root = sourceRoot(graph);
  if (!root) return;

  const existing = await storage.listChatBranches(chatId);
  const targetRoot =
    existing.find((branch) => branch.reason === "root") ?? existing[0];
  if (!targetRoot)
    throw new Error(`Restored chat has no SQL root branch: ${chatId}`);

  const idMap = new Map<string, string>([[root.id, targetRoot.id]]);
  const existingIds = new Set(existing.map((branch) => branch.id));
  const storedMessageIds = new Set(
    portableBranchPath(graph, root.id)
      .map((message) => message.chatId)
      .filter((id): id is string => Boolean(id)),
  );

  for (const branch of parentFirstBranches(graph)) {
    if (branch.id === root.id) continue;
    const parentBranchId = branch.parentBranchId
      ? idMap.get(branch.parentBranchId)
      : targetRoot.id;
    if (!parentBranchId) {
      throw new Error(`Missing parent branch while restoring ${branch.id}`);
    }

    let targetBranchId = branch.id;
    if (existingIds.has(targetBranchId)) targetBranchId = crypto.randomUUID();
    const created = await storage.createChatBranch({
      id: targetBranchId,
      chatId,
      parentBranchId,
      forkMessageId: branch.forkMessageId,
      reason: branch.reason === "reroll" ? "reroll" : "manual",
      createdAt: Number(branch.createdAt || 0),
    });
    existingIds.add(created.id);
    idMap.set(branch.id, created.id);

    const path = portableBranchPath(graph, branch.id) as Message[];
    const forkIndex = branch.forkMessageId
      ? path.findIndex((message) => message.chatId === branch.forkMessageId)
      : -1;
    const suffix = path.slice(forkIndex + 1).filter((message) => {
      const id = message.chatId;
      return Boolean(id && !storedMessageIds.has(id));
    });
    if (suffix.length > 0) {
      const commit = createEmptySqlCommit(
        storage.getRevision(),
        "restore-branch-graph",
      );
      commit.messages.push(
        ...suffix.map((message, index) => ({
          id: message.chatId!,
          chatId,
          position: forkIndex + 1 + index,
          data: sqlMessageData(message),
        })),
      );
      await storage.commit(commit);
      for (const message of suffix) storedMessageIds.add(message.chatId!);
    }
  }

  const targetActive = graph.activeBranchId
    ? idMap.get(graph.activeBranchId)
    : targetRoot.id;
  await storage.activateChatBranch(chatId, targetActive ?? targetRoot.id);
}

export async function restorePortableDatabaseBranchGraphs(
  storage: SqlBranchStorage,
  graphs: PortableBranchGraphMap,
): Promise<void> {
  for (const [chatId, graph] of Object.entries(graphs)) {
    await restorePortableChatBranchGraph(storage, chatId, graph);
  }
}
