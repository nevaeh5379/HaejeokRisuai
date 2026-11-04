export interface AuthorNoteFields {
  id: string;
  name: string;
  content: string;
  /** Maintained by storage; never writable directly. */
  updatedAt: number;
}

export type AuthorNoteUpdate = Partial<
  Pick<AuthorNoteFields, "name" | "content">
>;

type AuthorNoteRead = <K extends keyof AuthorNoteFields>(
  ...keys: [K, ...K[]]
) => Promise<Pick<AuthorNoteFields, K>>;
type AuthorNoteWrite = (patch: AuthorNoteUpdate) => Promise<void>;

/** Stateless note handle; storage owns revision updates and write serialization. */
export class AuthorNote {
  readonly id: string;
  readonly #read: AuthorNoteRead;
  readonly #write: AuthorNoteWrite;

  constructor(id: string, read: AuthorNoteRead, write: AuthorNoteWrite) {
    this.id = id;
    this.#read = read;
    this.#write = write;
  }

  get<K extends keyof AuthorNoteFields>(
    ...keys: [K, ...K[]]
  ): Promise<Pick<AuthorNoteFields, K>> {
    return this.#read(...keys);
  }

  update(patch: AuthorNoteUpdate): Promise<void> {
    if (Object.keys(patch).length === 0) return Promise.resolve();
    return this.#write(patch);
  }
}
