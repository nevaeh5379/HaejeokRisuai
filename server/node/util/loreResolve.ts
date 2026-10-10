import { matchLoreRequest } from "./loreMatch.ts";

function resolveLoreEntries(
  messages?: any,
  entries?: any,
  options: any = {},
): any {
  if (!Array.isArray(messages) || !Array.isArray(entries)) {
    throw new TypeError("messages and entries must be arrays");
  }
  if (entries.length > 10000) {
    throw new RangeError("Too many lore entries");
  }

  const activatedIndexes: any = new Set();
  const activationOrder: any = [];
  const recursivePrompts: any = [];
  const logs: any = [];
  let matching: any = true;

  while (matching) {
    matching = false;
    for (const entry of entries) {
      if (activatedIndexes.has(entry.index)) continue;

      let activated: any = entry.activated !== false;
      if (activated && entry.forceState === "none" && !entry.alwaysActive) {
        for (const query of entry.searchQueries || []) {
          const result: any = matchLoreRequest(
            messages,
            {
              keys: query.keys,
              searchDepth: entry.scanDepth,
              regex: entry.regex === true,
              fullWordMatching: entry.fullWordMatching === true,
              all: query.all,
              dontSearchWhenRecursive: entry.dontSearchWhenRecursive === true,
            },
            {
              username: options.username,
              charName: options.charName,
              recursivePrompts,
            },
          );
          logs.push(...result.logs);
          if (
            (query.negative && result.matched) ||
            (!query.negative && !result.matched)
          ) {
            activated = false;
            break;
          }
        }
      }

      if (entry.forceState === "activate") activated = true;
      else if (entry.forceState === "deactivate") activated = false;

      if (!activated) continue;
      activatedIndexes.add(entry.index);
      activationOrder.push(entry.index);
      if (entry.recursive) {
        matching = true;
        recursivePrompts.push({
          prompt: String(entry.content ?? ""),
          data: String(entry.content ?? ""),
          source: String(entry.source ?? `lorebook ${entry.index}`),
        });
      }
    }
  }

  return {
    activatedIndexes: activationOrder,
    logs,
  };
}

export { resolveLoreEntries };
