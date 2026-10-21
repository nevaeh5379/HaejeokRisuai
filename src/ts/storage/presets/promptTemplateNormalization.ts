import type { PromptItem } from "../../process/prompt";
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

function isItemNormalized(item: unknown): boolean {
  if (!item || typeof item !== "object") {
    return true;
  }
  const typed = item as any;
  switch (typed.type) {
    case "plain":
    case "jailbreak":
    case "cot": {
      const normalized = normalizePromptRole(typed.role) ?? "system";
      return typed.role === normalized;
    }
    case "persona":
    case "description":
    case "authornote":
    case "memory": {
      if (typed.role2 !== undefined && typed.role2 !== null) {
        const normalized = normalizePromptRole(typed.role2) ?? "system";
        return typed.role2 === normalized;
      }
      return true;
    }
    case "cache": {
      const normalized = normalizeCacheRole(typed.role);
      return typed.role === normalized;
    }
    default:
      return true;
  }
}

export function normalizePromptTemplate(
  template: PromptItem[] | null | undefined,
): PromptItem[] | null {
  if (!Array.isArray(template)) {
    return null;
  }
  let needsChange = false;
  for (let i = 0; i < template.length; i++) {
    if (!isItemNormalized(template[i])) {
      needsChange = true;
      break;
    }
  }
  if (!needsChange) {
    return template;
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
