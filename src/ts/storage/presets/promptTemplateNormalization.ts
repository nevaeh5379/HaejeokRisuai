import type { PromptItem } from "@risuai/protocol/domain/promptTypes.ts";
import { safeStructuredClone } from "../../polyfill";

function normalizePromptRole(role: unknown): "user" | "bot" | "system" | null {
  if (role === "user" || role === "bot" || role === "system") {
    return role;
  }
  if (role === "assistant" || role === "char") {
    return "bot";
  }
  return null;
}

function normalizeCacheRole(
  role: unknown,
): "user" | "assistant" | "system" | "all" {
  if (
    role === "user" ||
    role === "assistant" ||
    role === "system" ||
    role === "all"
  ) {
    return role;
  }
  if (role === "bot" || role === "char") {
    return "assistant";
  }
  return "all";
}

export function normalizePromptTemplate(
  template: PromptItem[] | null | undefined,
): PromptItem[] | null {
  if (!Array.isArray(template)) {
    return null;
  }
  const normalized = safeStructuredClone(template) as any[];
  for (const item of normalized) {
    if (!item || typeof item !== "object") {
      continue;
    }
    switch (item.type) {
      case "plain":
      case "jailbreak":
      case "cot": {
        item.role = normalizePromptRole(item.role) ?? "system";
        break;
      }
      case "persona":
      case "description":
      case "authornote":
      case "memory": {
        if (item.role2 !== undefined && item.role2 !== null) {
          item.role2 = normalizePromptRole(item.role2) ?? "system";
        }
        break;
      }
      case "cache": {
        item.role = normalizeCacheRole(item.role);
        break;
      }
    }
  }
  return normalized as PromptItem[];
}
