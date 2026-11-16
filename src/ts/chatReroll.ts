import type { Message } from "./storage/database/schema";
import type { SqlChatBranchSummary } from "./storage/sql/ISqlStorage";

export interface RerollAlternatives {
  parentBranchId: string;
  branchIds: string[];
  currentIndex: number;
}

// The replies available at one fork message: the branch that was rerolled
// first, followed by its reroll branches in creation order.
export function findRerollAlternatives(
  branches: SqlChatBranchSummary[],
  activeBranchId: string | undefined,
  forkMessageId: string | undefined,
): RerollAlternatives | null {
  const activeId =
    activeBranchId ?? branches.find((branch) => branch.reason === "root")?.id;
  const active = branches.find((branch) => branch.id === activeId);
  if (!activeId || !active) return null;
  const sameFork =
    active.reason === "reroll" &&
    (!active.forkMessageId ||
      !forkMessageId ||
      active.forkMessageId === forkMessageId);
  const parentBranchId = sameFork
    ? (active.parentBranchId ?? active.id)
    : active.id;
  const siblings = branches
    .filter(
      (branch) =>
        branch.reason === "reroll" &&
        branch.parentBranchId === parentBranchId &&
        (!forkMessageId ||
          !branch.forkMessageId ||
          branch.forkMessageId === forkMessageId),
    )
    .sort((a, b) => a.createdAt - b.createdAt);
  const branchIds = [
    parentBranchId,
    ...siblings.map((branch) => branch.id).filter((id) => id !== parentBranchId),
  ];
  return {
    parentBranchId,
    branchIds,
    currentIndex: Math.max(0, branchIds.indexOf(activeId)),
  };
}

export interface RerollTarget {
  branchMessageIndex: number;
  responseMessageIndex: number | null;
}

export function resolveRerollTarget(
  messages: Message[],
  requestedIndex?: number,
): RerollTarget | null {
  if (messages.length === 0) return null;
  const targetIndex =
    requestedIndex === undefined
      ? messages.length - 1
      : Math.min(messages.length - 1, Math.max(0, requestedIndex));
  const target = messages[targetIndex];
  if (!target) return null;

  if (target.role === "user") {
    let responseMessageIndex: number | null = null;
    for (let index = targetIndex + 1; index < messages.length; index++) {
      if (messages[index]?.role === "user") break;
      if (messages[index]?.role === "char" && !messages[index]?.isComment) {
        responseMessageIndex = index;
        break;
      }
    }
    return { branchMessageIndex: targetIndex, responseMessageIndex };
  }

  for (let index = targetIndex - 1; index >= 0; index--) {
    if (messages[index]?.role === "user" && !messages[index]?.isComment) {
      return { branchMessageIndex: index, responseMessageIndex: targetIndex };
    }
  }
  return null;
}
