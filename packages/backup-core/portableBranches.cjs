function cloneValue(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function pathForHead(headMessageId, messageById, parentById) {
  if (!headMessageId) return [];
  const reversed = [];
  const seen = new Set();
  let current = headMessageId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const message = messageById.get(current);
    if (!message) break;
    reversed.push(message);
    current = parentById.get(current);
  }
  return reversed.reverse().map(cloneValue);
}

function commonPrefixLength(paths) {
  if (paths.length === 0) return 0;
  let length = Math.min(...paths.map((path) => path.length));
  for (let index = 0; index < length; index++) {
    const id = paths[0][index]?.chatId;
    if (!id || paths.some((path) => path[index]?.chatId !== id)) return index;
  }
  return length;
}

function runtimeStateForBranch(chat, branchId, activeBranchId) {
  if (branchId === activeBranchId) {
    return {
      scriptstate: chat.scriptstate == null ? null : cloneValue(chat.scriptstate),
      GLGlobalVariables:
        chat.GLGlobalVariables == null ? null : cloneValue(chat.GLGlobalVariables),
      useLocallySetGlobalVariables: chat.useLocallySetGlobalVariables ?? null,
    };
  }
  const legacy = chat.branchState?.branches?.find((branch) => branch?.id === branchId);
  if (!legacy) return {};
  return {
    ...(Object.prototype.hasOwnProperty.call(legacy, "scriptstate")
      ? { scriptstate: cloneValue(legacy.scriptstate) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(legacy, "GLGlobalVariables")
      ? { GLGlobalVariables: cloneValue(legacy.GLGlobalVariables) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(legacy, "useLocallySetGlobalVariables")
      ? { useLocallySetGlobalVariables: legacy.useLocallySetGlobalVariables }
      : {}),
  };
}

function materializePortableBranchChat(sourceChat, graph) {
  const chat = cloneValue(sourceChat || {});
  const branches = Array.isArray(graph?.branches) ? graph.branches : [];
  if (branches.length <= 1) {
    delete chat.branchState;
    if (graph?.activeBranchId) chat.activeBranchId = graph.activeBranchId;
    return chat;
  }

  const messageById = new Map();
  for (const message of graph.messages || []) {
    if (message?.chatId) messageById.set(message.chatId, message);
  }
  const parentById = new Map(
    (graph.links || []).map((link) => [link.messageId, link.parentMessageId]),
  );
  const paths = new Map();
  for (const branch of branches) {
    const fallbackHead = branch.headMessageId || branch.forkMessageId;
    paths.set(branch.id, pathForHead(fallbackHead, messageById, parentById));
  }

  const allPaths = [...paths.values()];
  const prefixLength = commonPrefixLength(allPaths);
  const baseMessageIndex = prefixLength - 1;
  const activeBranchId =
    branches.some((branch) => branch.id === graph.activeBranchId)
      ? graph.activeBranchId
      : (branches.find((branch) => branch.reason === "root") || branches[0]).id;
  const activePath = paths.get(activeBranchId) || [];

  chat.message = cloneValue(activePath);
  chat.activeBranchId = activeBranchId;
  chat.messageOffset = 0;
  chat.messageTotal = activePath.length;
  chat.messagesLoaded = true;
  chat.messagesFullyLoaded = true;
  chat.detailsLoaded = true;
  chat.branchState = {
    baseMessageIndex,
    activeBranchId,
    branches: branches.map((branch) => {
      const path = paths.get(branch.id) || [];
      const forkIndex = branch.forkMessageId
        ? path.findIndex((message) => message.chatId === branch.forkMessageId)
        : baseMessageIndex;
      return {
        id: branch.id,
        ...(branch.parentBranchId ? { parentBranchId: branch.parentBranchId } : {}),
        ...(branch.forkMessageId ? { branchMessageId: branch.forkMessageId } : {}),
        branchMessageIndex: forkIndex >= 0 ? forkIndex : baseMessageIndex,
        reason: branch.reason,
        createdAt: Number(branch.createdAt || 0),
        messages: cloneValue(path.slice(prefixLength)),
        ...runtimeStateForBranch(chat, branch.id, activeBranchId),
      };
    }),
  };
  return chat;
}

async function materializePortableDatabaseBranches(database, loadGraph) {
  const result = cloneValue(database);
  for (const character of result.characters || []) {
    for (let index = 0; index < (character?.chats || []).length; index++) {
      const chat = character.chats[index];
      if (!chat?.id) continue;
      const graph = await loadGraph(chat.id);
      if (!graph) continue;
      character.chats[index] = materializePortableBranchChat(chat, graph);
    }
  }
  return result;
}

module.exports = {
  materializePortableBranchChat,
  materializePortableDatabaseBranches,
};
