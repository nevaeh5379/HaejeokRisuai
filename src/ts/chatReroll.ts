import type { Message } from "./storage/database/schema";

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
