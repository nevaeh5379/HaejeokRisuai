import type {
  BtwSession,
  loreBook,
  StreamingDisplayOptimizationMode,
} from "./database.ts";
import type { SerializableHypaV2Data } from "./hypaV2Data.ts";
import type { SerializableHypaV3Data } from "./hypaV3Data.ts";

/** Persisted chat fields. Messages, branch mutations and UI loading state have separate owners. */
export interface ChatFields {
  id: string;
  characterId: string;
  position: number;
  /** Derived from message ordering; changed through message APIs. */
  lastDate?: number;
  /** Changed only through branch.activate(). */
  activeBranchId?: string;
  note: string;
  globalAuthorNoteId?: string;
  name: string;
  localLore: loreBook[];
  sdData?: string;
  supaMemoryData?: string;
  hypaV2Data?: SerializableHypaV2Data;
  lastMemory?: string;
  suggestMessages?: string[];
  isStreaming?: boolean;
  activeStreamingDisplayOptimizationMode?: StreamingDisplayOptimizationMode;
  scriptstate?: { [key: string]: string | number | boolean };
  modules?: string[];
  bindedPersona?: string;
  fmIndex?: number;
  hypaV3Data?: SerializableHypaV3Data;
  folderId?: string;
  bookmarks?: string[];
  bookmarkNames?: { [chatId: string]: string };
  useLocallySetGlobalVariables?: boolean;
  GLGlobalVariables?: { [key: string]: string };
  onboardingDone?: boolean;
  btwSessions?: BtwSession[];
  activeBtwSessionId?: string;
}

export type ChatUpdate = Partial<
  Omit<
    ChatFields,
    "id" | "characterId" | "position" | "lastDate" | "activeBranchId"
  >
>;

const FIELD_NAMES = {
  id: true,
  characterId: true,
  position: true,
  lastDate: true,
  activeBranchId: true,
  note: true,
  globalAuthorNoteId: true,
  name: true,
  localLore: true,
  sdData: true,
  supaMemoryData: true,
  hypaV2Data: true,
  lastMemory: true,
  suggestMessages: true,
  isStreaming: true,
  activeStreamingDisplayOptimizationMode: true,
  scriptstate: true,
  modules: true,
  bindedPersona: true,
  fmIndex: true,
  hypaV3Data: true,
  folderId: true,
  bookmarks: true,
  bookmarkNames: true,
  useLocallySetGlobalVariables: true,
  GLGlobalVariables: true,
  onboardingDone: true,
  btwSessions: true,
  activeBtwSessionId: true,
} satisfies Record<keyof ChatFields, true>;
const READ_ONLY_FIELDS = new Set<string>([
  "id",
  "characterId",
  "position",
  "lastDate",
  "activeBranchId",
]);
const REQUIRED_FIELDS = new Set<string>(["name", "note", "localLore"]);

export function validateChatKeys(
  keys: readonly string[],
): (keyof ChatFields)[] {
  if (keys.length === 0)
    throw new TypeError("At least one chat field is required");
  for (const key of keys)
    if (!Object.hasOwn(FIELD_NAMES, key))
      throw new TypeError(`Unknown chat field: ${key}`);
  return [...new Set(keys)] as (keyof ChatFields)[];
}

/** Omitted keys are preserved; supplied arrays/objects replace that whole field.
 * Explicit undefined clears an optional field. Identity, ordering and derived values cannot be patched. */
export function validateChatUpdate(patch: ChatUpdate): void {
  for (const key of Object.keys(patch)) {
    if (!Object.hasOwn(FIELD_NAMES, key))
      throw new TypeError(`Unknown chat field: ${key}`);
    if (READ_ONLY_FIELDS.has(key))
      throw new TypeError(`Chat field is read-only: ${key}`);
    if (
      REQUIRED_FIELDS.has(key) &&
      patch[key as keyof ChatUpdate] === undefined
    )
      throw new TypeError(`Chat field cannot be undefined: ${key}`);
  }
}

type ChatRead = <K extends keyof ChatFields>(
  ...keys: [K, ...K[]]
) => Promise<Pick<ChatFields, K>>;
type ChatWrite = (patch: ChatUpdate) => Promise<void>;

/** A stateless handle; field values and caches belong to the storage layer. */
export class Chat {
  readonly id: string;
  readonly #read: ChatRead;
  readonly #write: ChatWrite;
  constructor(id: string, read: ChatRead, write: ChatWrite) {
    this.id = id;
    this.#read = read;
    this.#write = write;
  }
  get<K extends keyof ChatFields>(
    ...keys: [K, ...K[]]
  ): Promise<Pick<ChatFields, K>> {
    const unique = validateChatKeys(keys) as [K, ...K[]];
    return this.#read(...unique);
  }
  update(patch: ChatUpdate): Promise<void> {
    validateChatUpdate(patch);
    if (Object.keys(patch).length === 0) return Promise.resolve();
    return this.#write(patch);
  }
}
