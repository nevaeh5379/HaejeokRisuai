"use strict";

const NATIVE_BRANCH_GRAPHS_KEY = "haejeokBranchGraphs";

function cloneValue(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function randomUUID() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  throw new Error("A portable branch idFactory is required");
}

function stripLegacyBranchFields(chat) {
  delete chat.branch;
  delete chat.branchState;
  delete chat.activeBranchId;
  return chat;
}

function branchRoot(graph) {
  const branches = Array.isArray(graph?.branches) ? graph.branches : [];
  const ids = new Set(branches.map((branch) => branch?.id).filter(Boolean));
  return (
    branches.find((branch) => branch?.reason === "root") ||
    branches.find(
      (branch) =>
        branch?.id &&
        (!branch.parentBranchId || !ids.has(branch.parentBranchId)),
    ) ||
    branches[0]
  );
}

function portableBranchPath(graph, branchId) {
  const branch = (graph?.branches || []).find((item) => item?.id === branchId);
  if (!branch) return [];
  const messageById = new Map(
    (graph.messages || [])
      .filter((message) => message?.chatId)
      .map((message) => [message.chatId, message]),
  );
  const parentById = new Map(
    (graph.links || []).map((link) => [link.messageId, link.parentMessageId]),
  );
  const reversed = [];
  const seen = new Set();
  let current = branch.headMessageId || branch.forkMessageId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const message = messageById.get(current);
    if (!message) break;
    reversed.push(message);
    current = parentById.get(current);
  }
  return reversed.reverse().map(cloneValue);
}

function preparePortableChatForBranchRestore(sourceChat, graph) {
  const chat = stripLegacyBranchFields(cloneValue(sourceChat || {}));
  const root = branchRoot(graph);
  if (!root) return chat;
  const rootPath = portableBranchPath(graph, root.id);
  chat.message = rootPath;
  chat.messageOffset = 0;
  chat.messageTotal = rootPath.length;
  chat.messagesLoaded = true;
  chat.messagesFullyLoaded = true;
  chat.detailsLoaded = true;
  return chat;
}

async function attachPortableDatabaseBranchGraphs(database, loadGraph) {
  const result = cloneValue(database);
  const graphs = {};
  for (const character of result.characters || []) {
    for (const chat of character?.chats || []) {
      if (!chat) continue;
      stripLegacyBranchFields(chat);
      if (!chat.id) continue;
      const graph = await loadGraph(chat.id);
      if (Array.isArray(graph?.branches) && graph.branches.length > 1) {
        graphs[chat.id] = cloneValue(graph);
      }
    }
  }
  if (Object.keys(graphs).length > 0) result[NATIVE_BRANCH_GRAPHS_KEY] = graphs;
  else delete result[NATIVE_BRANCH_GRAPHS_KEY];
  return result;
}

function extractPortableDatabaseBranchGraphs(source) {
  const database = cloneValue(source || {});
  const raw = database[NATIVE_BRANCH_GRAPHS_KEY];
  const branchGraphs = raw && typeof raw === "object" ? cloneValue(raw) : {};
  delete database[NATIVE_BRANCH_GRAPHS_KEY];
  return { database, branchGraphs };
}

function preparePortableDatabaseForBranchRestore(source) {
  const { database, branchGraphs } =
    extractPortableDatabaseBranchGraphs(source);
  for (const character of database.characters || []) {
    for (let index = 0; index < (character?.chats || []).length; index++) {
      const chat = character.chats[index];
      if (!chat?.id) continue;
      const graph = branchGraphs[chat.id];
      if (graph) {
        character.chats[index] = preparePortableChatForBranchRestore(
          chat,
          graph,
        );
      }
    }
  }
  return { database, branchGraphs };
}

function cloneMessagesWithFreshIds(messages, idFactory) {
  const cloned = cloneValue(messages || []);
  const idMap = new Map();
  for (const message of cloned) {
    const oldId = message.chatId;
    const newId = idFactory();
    if (oldId) idMap.set(oldId, newId);
    message.chatId = newId;
  }
  return { messages: cloned, idMap };
}

function remapBookmarks(chat, idMap) {
  if (Array.isArray(chat.bookmarks)) {
    chat.bookmarks = chat.bookmarks.map((id) => idMap.get(id)).filter(Boolean);
  }
  if (chat.bookmarkNames && typeof chat.bookmarkNames === "object") {
    chat.bookmarkNames = Object.fromEntries(
      Object.entries(chat.bookmarkNames)
        .map(([id, value]) => [idMap.get(id), value])
        .filter(([id]) => Boolean(id)),
    );
  }
}

function standaloneChatFromGraph(source, messages, name, idFactory) {
  const chat = stripLegacyBranchFields(cloneValue(source));
  const cloned = cloneMessagesWithFreshIds(messages, idFactory);
  chat.id = idFactory();
  chat.name = name;
  chat.message = cloned.messages;
  remapBookmarks(chat, cloned.idMap);
  chat.isStreaming = false;
  delete chat.activeStreamingDisplayOptimizationMode;
  chat.preventMessageCompaction = false;
  chat.messagesLoaded = true;
  chat.messagesFullyLoaded = true;
  chat.messageOffset = 0;
  chat.messageTotal = chat.message.length;
  chat.detailsLoaded = true;
  return chat;
}

function expandChatBranchGraphForCompatibility(
  source,
  graph,
  idFactory = randomUUID,
) {
  const branches = Array.isArray(graph?.branches) ? [...graph.branches] : [];
  if (branches.length <= 1) {
    return {
      chats: [stripLegacyBranchFields(cloneValue(source))],
      activeIndex: 0,
    };
  }
  const root = branchRoot(graph);
  const ordered = branches.sort((left, right) => {
    if (left.id === root?.id) return -1;
    if (right.id === root?.id) return 1;
    return Number(left.createdAt || 0) - Number(right.createdAt || 0);
  });
  let branchIndex = 0;
  let rerollIndex = 0;
  const chats = ordered.map((branch) => {
    const suffix =
      branch.id === root?.id
        ? ""
        : branch.reason === "reroll"
          ? ` (Reroll ${++rerollIndex})`
          : ` (Branch ${++branchIndex})`;
    return standaloneChatFromGraph(
      source,
      portableBranchPath(graph, branch.id),
      `${source.name || "Chat"}${suffix}`,
      idFactory,
    );
  });
  return {
    chats,
    activeIndex: Math.max(
      0,
      ordered.findIndex((branch) => branch.id === graph.activeBranchId),
    ),
  };
}

function expandPortableDatabaseBranchGraphsForCompatibility(
  source,
  idFactory = randomUUID,
) {
  const { database, branchGraphs } =
    extractPortableDatabaseBranchGraphs(source);
  for (const character of database.characters || []) {
    const sourceChats = Array.isArray(character?.chats) ? character.chats : [];
    const nextChats = [];
    let nextChatPage = 0;
    for (let index = 0; index < sourceChats.length; index++) {
      const chat = sourceChats[index];
      const graph = chat?.id ? branchGraphs[chat.id] : undefined;
      const expanded = graph
        ? expandChatBranchGraphForCompatibility(chat, graph, idFactory)
        : {
            chats: [stripLegacyBranchFields(cloneValue(chat))],
            activeIndex: 0,
          };
      if (index === Number(character.chatPage || 0)) {
        nextChatPage = nextChats.length + expanded.activeIndex;
      }
      nextChats.push(...expanded.chats);
    }
    character.chats = nextChats;
    character.chatPage = Math.min(
      Math.max(0, nextChatPage),
      Math.max(0, nextChats.length - 1),
    );
  }
  return database;
}

module.exports = {
  NATIVE_BRANCH_GRAPHS_KEY,
  attachPortableDatabaseBranchGraphs,
  extractPortableDatabaseBranchGraphs,
  preparePortableChatForBranchRestore,
  preparePortableDatabaseForBranchRestore,
  expandChatBranchGraphForCompatibility,
  expandPortableDatabaseBranchGraphsForCompatibility,
  portableBranchPath,
};
