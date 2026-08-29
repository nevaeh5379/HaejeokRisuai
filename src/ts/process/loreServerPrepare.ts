import { CCardLib } from "@risuai/ccardlib";
import type { loreBook } from "../storage/database/schema";

export type PreparedLoreQuery = {
  keys: string[];
  negative: boolean;
  all?: boolean;
};

export type PreparedServerLoreEntry = {
  index: number;
  activated: boolean;
  alwaysActive: boolean;
  forceState: "none" | "activate" | "deactivate";
  recursive: boolean;
  content: string;
  source: string;
  regex: boolean;
  scanDepth: number;
  fullWordMatching: boolean;
  dontSearchWhenRecursive: boolean;
  searchQueries: PreparedLoreQuery[];
  depth: number;
  pos: string;
  role: "system" | "user" | "assistant";
  order: number;
  priority: number;
  inject: LoreInjection | null;
};
export type LoreInjection = {
  operation: "append" | "prepend" | "replace";
  location: string;
  param: string;
  lore: boolean;
};

export type LorePrepareOptions = {
  scanDepth: number;
  fullWordMatching: boolean;
  recursiveScanning: boolean;
  chatLength: number;
  greetingIndex: number;
};

const UNSAFE_DIRECTIVES = new Set([
  "keep_activate_after_match",
  "dont_activate_after_match",
  "probability",
]);

export function prepareLoreEntriesForServer(
  fullLore: loreBook[],
  options: LorePrepareOptions,
): PreparedServerLoreEntry[] | null {
  if (fullLore.some((lore) => lore.mode === "child")) return null;
  if (fullLore.some((lore) => lore.content.split("\n").some((line) => line.trim().startsWith("@@@")))) {
    return null;
  }
  const prepared: PreparedServerLoreEntry[] = [];

  try {
    for (let i = 0; i < fullLore.length; i++) {
      const lore = fullLore[i];
      if (!lore.alwaysActive && !lore.key) continue;

      let activated = true;
      let forceState: PreparedServerLoreEntry["forceState"] = "none";
      let scanDepth = options.scanDepth;
      let fullWordMatching = options.fullWordMatching;
      let dontSearchWhenRecursive = false;
      let itemRecursive: "global" | boolean = "global";
      let depth = 0;
      let pos = "";
      let role: PreparedServerLoreEntry["role"] = "system";
      let order = lore.insertorder;
      let priority = lore.insertorder;
      let inject: LoreInjection | null = null;
      let unsafe = false;
      const searchQueries: PreparedLoreQuery[] = [];

      const content = CCardLib.decorator.parse(lore.content, (name, arg) => {
        if (UNSAFE_DIRECTIVES.has(name)) {
          unsafe = true;
          return false;
        }
        switch (name) {
          case "end":
            pos = "depth";
            depth = 0;
            return;
          case "activate_only_after": {
            const value = parseInt(arg[0]);
            if (!Number.isNaN(value) && options.chatLength < value) activated = false;
            return;
          }
          case "activate_only_every": {
            const value = parseInt(arg[0]);
            if (!Number.isNaN(value) && options.chatLength % value !== 0) activated = false;
            return;
          }
          case "depth":
          case "reverse_depth": {
            const value = parseInt(arg[0]);
            if (!Number.isNaN(value)) {
              depth = value;
              pos = name === "depth" ? "depth" : "reverse_depth";
            }
            return;
          }
          case "role":
            if (arg[0] === "user" || arg[0] === "assistant" || arg[0] === "system") role = arg[0];
            return;
          case "scan_depth":
            scanDepth = parseInt(arg[0]);
            return;
          case "is_greeting": {
            const value = parseInt(arg[0]);
            if (!Number.isNaN(value) && options.greetingIndex !== value) activated = false;
            return;
          }
          case "position":
            if (arg[0]?.startsWith("pt_") || ["after_desc", "before_desc", "personality", "scenario"].includes(arg[0])) {
              pos = arg[0];
            }
            return;
          case "inject_lore":
            inject ??= { operation: "append", location: "", param: "", lore: true };
            inject.location = arg.join(" ");
            inject.lore = true;
            return;
          case "inject_at":
            inject ??= { operation: "append", location: "", param: "", lore: false };
            inject.location = arg.join(" ");
            inject.lore = false;
            return;
          case "inject_replace":
            inject ??= { operation: "replace", location: "", param: "", lore: false };
            inject.operation = "replace";
            inject.param = arg.join(" ");
            return;
          case "inject_prepend":
            inject ??= { operation: "prepend", location: "", param: "", lore: false };
            inject.operation = "prepend";
            inject.param = arg.join(" ");
            return;
          case "ignore_on_max_context":
            priority = -1000;
            return;
          case "additional_keys":
            searchQueries.push({ keys: arg, negative: false });
            return;
          case "exclude_keys":
            searchQueries.push({ keys: arg, negative: true });
            return;
          case "exclude_keys_all":
            searchQueries.push({ keys: arg, negative: true, all: true });
            return;
          case "match_full_word":
            fullWordMatching = true;
            return;
          case "match_partial_word":
            fullWordMatching = false;
            return;
          case "activate":
            forceState = "activate";
            return;
          case "dont_activate":
            forceState = "deactivate";
            return;
          case "unrecursive":
            itemRecursive = false;
            return;
          case "recursive":
            itemRecursive = true;
            return;
          case "no_recursive_search":
            dontSearchWhenRecursive = true;
            return;
          case "priority":
            priority = parseInt(arg[0]);
            return;
          case "instruct_depth":
          case "reverse_instruct_depth":
          case "instruct_scan_depth":
          case "is_user_icon":
          case "disable_ui_prompt":
            return false;
          default:
            return false;
        }
      });

      if (unsafe || !Number.isFinite(scanDepth) || !Number.isFinite(priority)) return null;
      if (activated && forceState === "none" && !lore.alwaysActive) {
        searchQueries.push({ keys: lore.key.split(","), negative: false });
        if (lore.secondkey && lore.selective) {
          searchQueries.push({ keys: lore.secondkey.split(","), negative: false });
        }
      }
      let recursive = options.recursiveScanning;
      if (itemRecursive !== "global") recursive = itemRecursive;

      prepared.push({
        index: i,
        activated,
        alwaysActive: lore.alwaysActive ?? false,
        forceState,
        recursive,
        content,
        source: lore.comment || `lorebook ${i}`,
        regex: lore.useRegex ?? false,
        scanDepth,
        fullWordMatching,
        dontSearchWhenRecursive,
        searchQueries,
        depth,
        pos,
        role,
        order,
        priority,
        inject,
      });
    }
  } catch {
    return null;
  }

  return prepared;
}
