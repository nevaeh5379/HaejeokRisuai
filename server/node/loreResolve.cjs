const { matchLoreRequest } = require("./loreMatch.cjs");

function resolveLoreEntries(messages, entries, options = {}) {
  if (!Array.isArray(messages) || !Array.isArray(entries)) {
    throw new TypeError("messages and entries must be arrays");
  }
  if (entries.length > 10000) {
    throw new RangeError("Too many lore entries");
  }

  const activatedIndexes = new Set();
  const activationOrder = [];
  const recursivePrompts = [];
  const logs = [];
  let matching = true;

  while (matching) {
    matching = false;
    for (const entry of entries) {
      if (activatedIndexes.has(entry.index)) continue;

      let activated = entry.activated !== false;
      if (activated && entry.forceState === "none" && !entry.alwaysActive) {
        for (const query of entry.searchQueries || []) {
          const result = matchLoreRequest(
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

module.exports = { resolveLoreEntries };
