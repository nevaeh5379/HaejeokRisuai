import { v4 as uuidv4 } from "uuid";
import { getChatBranchMessages } from "./chatBranches";
import { safeStructuredClone } from "./polyfill";
import { coldStorageHeader } from "./process/coldstorageData";
import type {
  Chat,
  character,
  groupChat,
  Message,
} from "./storage/database.svelte";

type IdFactory = () => string;
type BackupCharacter = character | groupChat;
export type ColdStorageValueMap = ReadonlyMap<string, unknown>;

export interface ExpandedChatBackup {
  chats: Chat[];
  activeIndex: number;
}

function coldStorageValue(
  values: ColdStorageValueMap | undefined,
  key: string | undefined,
): unknown {
  if (!key || !values) return undefined;
  return values.get(key);
}

function materializeColdChat(
  source: Chat,
  values: ColdStorageValueMap | undefined,
): Chat {
  const chat = safeStructuredClone(source);
  const pointer = chat.message?.[0]?.data;
  if (!pointer?.startsWith(coldStorageHeader)) return chat;

  const key = pointer.slice(coldStorageHeader.length);
  const stored = coldStorageValue(values, key);
  if (Array.isArray(stored)) {
    chat.message = safeStructuredClone(stored as Message[]);
  } else if (stored && typeof stored === "object" && "message" in stored) {
    const data = stored as Partial<Chat> & { message: Message[] };
    chat.message = safeStructuredClone(data.message ?? []);
    chat.hypaV2Data = safeStructuredClone(data.hypaV2Data);
    chat.hypaV3Data = safeStructuredClone(data.hypaV3Data);
    chat.scriptstate = safeStructuredClone(data.scriptstate);
    chat.localLore = safeStructuredClone(data.localLore ?? chat.localLore);
  }
  return chat;
}

export function materializeColdCharacterForCompatibility(
  source: BackupCharacter,
  values?: ColdStorageValueMap,
): BackupCharacter {
  let base = source;
  let wholeCharacterRestored = !source.coldstorage;
  const stored = coldStorageValue(values, source.coldstorage);
  if (stored && typeof stored === "object" && "character" in stored) {
    const restored = (stored as { character?: BackupCharacter }).character;
    if (restored && (!source.chaId || restored.chaId === source.chaId)) {
      base = restored;
      wholeCharacterRestored = true;
    }
  }

  const character = safeStructuredClone(base);
  character.chats = (base.chats ?? []).map((chat) =>
    materializeColdChat(chat, values),
  );
  const hasColdChatPointers = character.chats.some((chat) =>
    chat.message?.[0]?.data?.startsWith(coldStorageHeader),
  );
  if (wholeCharacterRestored && !hasColdChatPointers) {
    delete character.coldstorage;
    delete character.coldStoragedChats;
  } else {
    if (source.coldstorage) character.coldstorage = source.coldstorage;
    if (source.coldStoragedChats) {
      character.coldStoragedChats = safeStructuredClone(source.coldStoragedChats);
    }
  }
  return character;
}

function cloneMessagesWithFreshIds(
  messages: Message[],
  idFactory: IdFactory,
): { messages: Message[]; idMap: Map<string, string> } {
  const idMap = new Map<string, string>();
  const cloned = safeStructuredClone(messages);
  for (const message of cloned) {
    const oldId = message.chatId;
    const newId = idFactory();
    if (oldId) idMap.set(oldId, newId);
    message.chatId = newId;
  }
  return { messages: cloned, idMap };
}
function remapBookmarks(chat: Chat, idMap: Map<string, string>): void {
  if (chat.bookmarks) {
    chat.bookmarks = chat.bookmarks
      .map((id) => idMap.get(id))
      .filter((id): id is string => Boolean(id));
  }
  if (chat.bookmarkNames) {
    chat.bookmarkNames = Object.fromEntries(
      Object.entries(chat.bookmarkNames)
        .map(([id, name]) => [idMap.get(id), name] as const)
        .filter((entry): entry is [string, string] => Boolean(entry[0])),
    );
  }
}

function finalizeStandaloneChat(
  source: Chat,
  messages: Message[],
  name: string,
  idFactory: IdFactory,
): Chat {
  const chat = safeStructuredClone(source);
  const cloned = cloneMessagesWithFreshIds(messages, idFactory);
  chat.id = idFactory();
  chat.name = name;
  chat.message = cloned.messages;
  remapBookmarks(chat, cloned.idMap);
  delete chat.branch;
  delete chat.branchState;
  chat.isStreaming = false;
  chat.activeStreamingDisplayOptimizationMode = undefined;
  chat.preventMessageCompaction = false;
  chat.messagesLoaded = true;
  chat.messagesFullyLoaded = true;
  chat.messageOffset = 0;
  chat.messageTotal = chat.message.length;
  chat.detailsLoaded = true;
  return chat;
}

export function expandChatBranchesForCompatibility(
  source: Chat,
  idFactory: IdFactory = uuidv4,
): ExpandedChatBackup {
  const state = source.branchState;
  if (!state || !Array.isArray(state.branches) || state.branches.length <= 1) {
    const chat = safeStructuredClone(source);
    delete chat.branch;
    delete chat.branchState;
    return { chats: [chat], activeIndex: 0 };
  }

  const ordered = [...state.branches].sort((left, right) => {
    if (left.reason === "root" && right.reason !== "root") return -1;
    if (right.reason === "root" && left.reason !== "root") return 1;
    return left.createdAt - right.createdAt;
  });
  let manualIndex = 0;
  let rerollIndex = 0;
  const chats = ordered.map((branch) => {
    const suffix = branch.reason === "root"
      ? ""
      : branch.reason === "reroll"
        ? ` (Reroll ${++rerollIndex})`
        : ` (Branch ${++manualIndex})`;
    return finalizeStandaloneChat(
      source,
      getChatBranchMessages(source, branch.id),
      `${source.name}${suffix}`,
      idFactory,
    );
  });

  const activeIndex = Math.max(
    0,
    ordered.findIndex((branch) => branch.id === state.activeBranchId),
  );
  return { chats, activeIndex };
}

export function expandCharacterBranchesForCompatibility(
  source: BackupCharacter,
  idFactory: IdFactory = uuidv4,
  coldStorageValues?: ColdStorageValueMap,
): BackupCharacter {
  const materialized = materializeColdCharacterForCompatibility(
    source,
    coldStorageValues,
  );
  const character = safeStructuredClone(materialized);
  const nextChats: Chat[] = [];
  let nextChatPage = 0;

  for (let index = 0; index < materialized.chats.length; index++) {
    const expanded = expandChatBranchesForCompatibility(
      materialized.chats[index],
      idFactory,
    );
    if (index === materialized.chatPage) {
      nextChatPage = nextChats.length + expanded.activeIndex;
    }
    nextChats.push(...expanded.chats);
  }

  character.chats = nextChats;
  character.chatPage = Math.min(
    Math.max(0, nextChatPage),
    Math.max(0, nextChats.length - 1),
  );
  return character;
}

export function expandCharactersForCompatibility(
  characters: BackupCharacter[],
  idFactory: IdFactory = uuidv4,
  coldStorageValues?: ColdStorageValueMap,
): BackupCharacter[] {
  return characters.map((character) =>
    expandCharacterBranchesForCompatibility(
      character,
      idFactory,
      coldStorageValues,
    ),
  );
}
