export interface LegacyBranchMigrationMessage {
  id: string;
  position: number;
  data: Record<string, unknown>;
}

export interface LegacyBranchMigrationLink {
  messageId: string;
  parentMessageId?: string;
  originBranchId: string;
}

export interface LegacyBranchMigrationBranch {
  id: string;
  parentBranchId?: string;
  forkMessageId?: string;
  headMessageId?: string;
  reason: "root" | "manual" | "reroll";
  createdAt: number;
  runtimeState: Record<string, unknown>;
}

export interface LegacyBranchMigrationPlan {
  chatId: string;
  activeBranchId: string;
  branches: LegacyBranchMigrationBranch[];
  messages: LegacyBranchMigrationMessage[];
  links: LegacyBranchMigrationLink[];
}
("use strict");

function cloneValue(value?: any): any {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function messageSignature(message?: any): any {
  const cloned: any = { ...(message || {}) };
  delete cloned.chatId;
  return JSON.stringify(cloned, (_key?: any, value?: any) =>
    value === undefined ? "__RISU_UNDEFINED__" : value,
  );
}

function materializeLegacyTimeline(chat: any, branch: any): any[];
function materializeLegacyTimeline(chat?: any, branch?: any): any {
  const state: any = chat.branchState;
  if (!state || branch.id === state.activeBranchId)
    return cloneValue(chat.message || []);
  const base: any = Number.isInteger(state.baseMessageIndex)
    ? state.baseMessageIndex
    : -1;
  const prefix: any = (chat.message || []).slice(0, Math.max(0, base + 1));
  return [...cloneValue(prefix), ...cloneValue(branch.messages || [])];
}

function orderLegacyBranches(branches?: any): any {
  const byId: any = new Map(
    branches.map((branch?: any) => [branch.id, branch]),
  );
  const ordered: any = [];
  const visiting: any = new Set();
  const visited: any = new Set();
  const sorted: any = [...branches].sort((left?: any, right?: any) => {
    if (left.reason === "root" && right.reason !== "root") return -1;
    if (right.reason === "root" && left.reason !== "root") return 1;
    return Number(left.createdAt || 0) - Number(right.createdAt || 0);
  });
  const visit: any = (branch?: any) => {
    if (!branch || visited.has(branch.id)) return;
    if (visiting.has(branch.id)) return;
    visiting.add(branch.id);
    if (branch.parentBranchId && byId.has(branch.parentBranchId))
      visit(byId.get(branch.parentBranchId));
    visiting.delete(branch.id);
    visited.add(branch.id);
    ordered.push(branch);
  };
  sorted.forEach(visit);
  return ordered;
}

function buildLegacyBranchMigrationPlan(
  chat: any,
  idFactory: () => string,
): LegacyBranchMigrationPlan | null;
function buildLegacyBranchMigrationPlan(chat?: any, idFactory?: any): any {
  const state: any = chat?.branchState;
  const sourceBranches: any = Array.isArray(state?.branches)
    ? state.branches.filter((branch?: any) => branch?.id)
    : [];
  if (!chat?.id || sourceBranches.length <= 1) return null;
  if (typeof idFactory !== "function")
    throw new TypeError("idFactory is required");

  const ordered: any = orderLegacyBranches(sourceBranches);
  const branchIds: any = new Set(ordered.map((branch?: any) => branch.id));
  const root: any =
    ordered.find((branch?: any) => branch.reason === "root") ||
    ordered.find(
      (branch?: any) =>
        !branch.parentBranchId || !branchIds.has(branch.parentBranchId),
    ) ||
    ordered[0];
  const paths: any = new Map();
  const nodeVariants: any = new Map();
  const usedIds: any = new Set();
  const messages: any = new Map();
  const links: any = new Map();

  const resolveNode: any = (
    branchId?: any,
    message?: any,
    parentMessageId?: any,
    position?: any,
  ) => {
    const rawId: any =
      typeof message?.chatId === "string" && message.chatId
        ? message.chatId
        : null;
    const signature: any = messageSignature(message);
    const variantKey: any = `${rawId || "__NO_ID__"}\u0000${parentMessageId || "__ROOT__"}\u0000${signature}`;
    let resolvedId: any = nodeVariants.get(variantKey);
    if (!resolvedId) {
      if (rawId && !usedIds.has(rawId)) resolvedId = rawId;
      else {
        do {
          resolvedId = idFactory();
        } while (!resolvedId || usedIds.has(resolvedId));
      }
      usedIds.add(resolvedId);
      nodeVariants.set(variantKey, resolvedId);
      const stored: any = cloneValue(message || {});
      stored.chatId = resolvedId;
      messages.set(resolvedId, { id: resolvedId, position, data: stored });
      links.set(resolvedId, {
        messageId: resolvedId,
        parentMessageId: parentMessageId || undefined,
        originBranchId: branchId,
      });
    }
    return resolvedId;
  };

  for (const branch of ordered) {
    const timeline: any = materializeLegacyTimeline(chat, branch);
    const path: any = [];
    let parentMessageId: any;
    for (let position: any = 0; position < timeline.length; position++) {
      const resolvedId: any = resolveNode(
        branch.id,
        timeline[position],
        parentMessageId,
        position,
      );
      path.push(resolvedId);
      parentMessageId = resolvedId;
    }
    paths.set(branch.id, path);
  }

  const rows: any = ordered.map((branch?: any) => {
    let parentBranchId: any =
      branch.parentBranchId && branchIds.has(branch.parentBranchId)
        ? branch.parentBranchId
        : undefined;
    if (branch.id === root.id) parentBranchId = undefined;
    else if (!parentBranchId) parentBranchId = root.id;
    const path: any = paths.get(branch.id) || [];
    const parentPath: any = parentBranchId
      ? paths.get(parentBranchId) || []
      : [];
    let common: any = 0;
    while (
      common < path.length &&
      common < parentPath.length &&
      path[common] === parentPath[common]
    )
      common++;
    const forkMessageId: any = common > 0 ? path[common - 1] : undefined;
    return {
      id: branch.id,
      parentBranchId,
      forkMessageId,
      headMessageId: path.at(-1),
      reason:
        branch.id === root.id
          ? "root"
          : branch.reason === "reroll"
            ? "reroll"
            : "manual",
      createdAt: Number(branch.createdAt || 0),
      runtimeState: {
        ...(Object.prototype.hasOwnProperty.call(branch, "scriptstate")
          ? { scriptstate: cloneValue(branch.scriptstate) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(branch, "GLGlobalVariables")
          ? { GLGlobalVariables: cloneValue(branch.GLGlobalVariables) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(
          branch,
          "useLocallySetGlobalVariables",
        )
          ? {
              useLocallySetGlobalVariables: branch.useLocallySetGlobalVariables,
            }
          : {}),
      },
    };
  });

  const activeBranchId: any = branchIds.has(state.activeBranchId)
    ? state.activeBranchId
    : root.id;
  return {
    chatId: chat.id,
    activeBranchId,
    branches: rows,
    messages: [...messages.values()],
    links: [...links.values()],
  };
}

export { buildLegacyBranchMigrationPlan, materializeLegacyTimeline };
