export type CloneValue = <T>(value: T) => T;
export type IdFactory = () => string;
export type ColdStorageValueMap = ReadonlyMap<string, unknown>;
export interface CompatibilityOptions {
  cloneValue?: CloneValue;
  coldStorageHeader?: string;
  idFactory?: IdFactory;
}
export interface ExpandedChatBackup<TChat = any> {
  chats: TChat[];
  activeIndex: number;
}
export const COLD_STORAGE_HEADER: string;
export function materializeColdCharacterForCompatibility<T>(
  source: T,
  values?: ColdStorageValueMap,
  options?: CompatibilityOptions,
): T;
export function expandChatBranchesForCompatibility<T>(
  source: T,
  idFactory?: IdFactory,
  options?: CompatibilityOptions,
): ExpandedChatBackup<T>;
export function expandCharacterBranchesForCompatibility<T>(
  source: T,
  idFactory?: IdFactory,
  coldStorageValues?: ColdStorageValueMap,
  options?: CompatibilityOptions,
): T;
export function expandCharactersForCompatibility<T>(
  characters: T[],
  idFactory?: IdFactory,
  coldStorageValues?: ColdStorageValueMap,
  options?: CompatibilityOptions,
): T[];
export function makeLegacyCompatibleDatabase<T>(
  database: T,
  coldStorageValues?: ColdStorageValueMap,
  options?: CompatibilityOptions,
): T;
