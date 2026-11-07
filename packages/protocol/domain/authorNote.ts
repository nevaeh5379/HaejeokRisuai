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

type AuthorNoteWrite = (patch: AuthorNoteUpdate) => Promise<void>;

/** Stateless note handle; storage owns revision updates and write serialization. */
export class AuthorNote {
  readonly id: string;
  readonly #read: () => Promise<AuthorNoteFields>;
  readonly #write: AuthorNoteWrite;

  constructor(
    id: string,
    read: () => Promise<AuthorNoteFields>,
    write: AuthorNoteWrite,
  ) {
    this.id = id;
    this.#read = read;
    this.#write = write;
  }

  get(): Promise<AuthorNoteFields> {
    return this.#read();
  }

  update(patch: AuthorNoteUpdate): Promise<void> {
    if (Object.keys(patch).length === 0) return Promise.resolve();
    return this.#write(patch);
  }
}
