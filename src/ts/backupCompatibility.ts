import { v4 as uuidv4 } from "uuid";
import {
  expandCharacterBranchesForCompatibility as expandCharacterBranchesCore,
  expandCharactersForCompatibility as expandCharactersCore,
  expandChatBranchesForCompatibility as expandChatBranchesCore,
  makeLegacyCompatibleDatabase as makeLegacyCompatibleDatabaseCore,
  materializeColdCharacterForCompatibility as materializeColdCharacterCore,
} from "@risuai/backup-core/compatibility.cjs";
import { safeStructuredClone } from "./polyfill";
import { coldStorageHeader } from "./process/coldstorageData";
import type { Chat, character, groupChat } from "./storage/schema";

type IdFactory = () => string;
type BackupCharacter = character | groupChat;
export type ColdStorageValueMap = ReadonlyMap<string, unknown>;

export interface ExpandedChatBackup {
  chats: Chat[];
  activeIndex: number;
}

const compatibilityOptions = {
  cloneValue: safeStructuredClone,
  coldStorageHeader,
  idFactory: uuidv4,
};

export function materializeColdCharacterForCompatibility(
  source: BackupCharacter,
  values?: ColdStorageValueMap,
): BackupCharacter {
  return materializeColdCharacterCore(
    source,
    values,
    compatibilityOptions,
  ) as BackupCharacter;
}

export function expandChatBranchesForCompatibility(
  source: Chat,
  idFactory: IdFactory = uuidv4,
): ExpandedChatBackup {
  return expandChatBranchesCore(
    source,
    idFactory,
    compatibilityOptions,
  ) as ExpandedChatBackup;
}

export function expandCharacterBranchesForCompatibility(
  source: BackupCharacter,
  idFactory: IdFactory = uuidv4,
  coldStorageValues?: ColdStorageValueMap,
): BackupCharacter {
  return expandCharacterBranchesCore(
    source,
    idFactory,
    coldStorageValues,
    compatibilityOptions,
  ) as BackupCharacter;
}

export function expandCharactersForCompatibility(
  characters: BackupCharacter[],
  idFactory: IdFactory = uuidv4,
  coldStorageValues?: ColdStorageValueMap,
): BackupCharacter[] {
  return expandCharactersCore(
    characters,
    idFactory,
    coldStorageValues,
    compatibilityOptions,
  ) as BackupCharacter[];
}

export function makeLegacyCompatibleDatabase<T extends object>(
  database: T,
  coldStorageValues: ColdStorageValueMap = new Map(),
): T {
  return makeLegacyCompatibleDatabaseCore(
    database,
    coldStorageValues,
    compatibilityOptions,
  ) as T;
}
