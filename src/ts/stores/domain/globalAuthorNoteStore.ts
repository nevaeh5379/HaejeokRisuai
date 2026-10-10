import { v4 } from "uuid";
import type { ISqlStorage } from "../../storage/sql/ISqlStorage";
import { createEmptySqlCommit } from "../../storage/sql/sqlCommit";
import { commitSqlChanges } from "../../storage/sql/sqlCommitCoordinator";
import {
  AuthorNoteError,
  type AuthorNoteMetadata,
  type AuthorNoteOperation,
} from "@risuai/protocol/src/authorNotes.ts";

export interface GlobalAuthorNote {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: number;
  readonly contentHash: string | null;
  getContent(): Promise<string>;
  setContent(content: string, options?: { force?: boolean }): Promise<void>;
}
export interface GlobalAuthorNoteStore {
  init(storage: ISqlStorage): Promise<void>;
  list(): Promise<readonly GlobalAuthorNote[]>;
  get(id: string): Promise<GlobalAuthorNote | null>;
  create(name: string, content?: string): Promise<GlobalAuthorNote>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
  getAllowScriptWrite(): Promise<boolean>;
  setAllowScriptWrite(value: boolean): Promise<void>;
  waitForPendingWrites(): Promise<void>;
  dispose(): Promise<void>;
}
class NoteObject implements GlobalAuthorNote {
  private hash: string | null;
  private timestamp: number;
  private queue: Promise<unknown> = Promise.resolve();
  readonly id: string;
  readonly name: string;
  constructor(
    private readonly store: SqlGlobalAuthorNoteStore,
    private readonly storage: ISqlStorage,
    private readonly generation: number,
    metadata: AuthorNoteMetadata,
    hash: string | null = null,
  ) {
    this.id = metadata.id;
    this.name = metadata.name;
    this.timestamp = metadata.updatedAt;
    this.hash = hash;
  }
  get contentHash() {
    return this.hash;
  }
  get updatedAt() {
    return this.timestamp;
  }
  private run<T>(task: () => Promise<T>): Promise<T> {
    const pending = this.queue
      .catch(() => undefined)
      .then(async () => {
        this.store.assertCurrent(this.storage, this.generation);
        return task();
      });
    this.queue = pending;
    return pending;
  }
  getContent(): Promise<string> {
    return this.run(async () => {
      const row = await this.storage.readGlobalAuthorNote(this.id);
      this.store.assertCurrent(this.storage, this.generation);
      if (!row) throw new AuthorNoteError("missing", this.id);
      this.hash = row.contentHash;
      this.timestamp = row.updatedAt;
      return row.content;
    });
  }
  setContent(content: string, options?: { force?: boolean }): Promise<void> {
    return this.save(content, options);
  }
  save(
    content: string,
    options?: { force?: boolean; script?: boolean },
  ): Promise<void> {
    return this.store.track(
      this.run(async () => {
        const result = await this.store.write(this.storage, {
          type: "content",
          id: this.id,
          content,
          expectedHash: this.hash,
          force: options?.force,
          script: options?.script,
        });
        const row = result.authorNotes?.find((entry) => entry.id === this.id);
        if (!row) throw new Error("Missing committed author note metadata");
        this.hash = row.contentHash;
        this.timestamp = row.updatedAt;
      }),
    );
  }
}
/** No content, metadata, setting cache or automatic save timer lives here. */
export class SqlGlobalAuthorNoteStore implements GlobalAuthorNoteStore {
  private storage: ISqlStorage | null = null;
  private generation = 0;
  private readonly writes = new Set<Promise<unknown>>();
  async init(storage: ISqlStorage): Promise<void> {
    if (this.storage === storage) return;
    await this.waitForPendingWrites();
    this.storage = storage;
    this.generation++;
  }
  assertCurrent(storage: ISqlStorage, generation: number) {
    if (storage !== this.storage || generation !== this.generation)
      throw new AuthorNoteError("disposed");
  }
  private requireStorage() {
    if (!this.storage) throw new AuthorNoteError("disposed");
    return this.storage;
  }
  track<T>(operation: Promise<T>): Promise<T> {
    this.writes.add(operation);
    void operation.then(
      () => this.writes.delete(operation),
      () => this.writes.delete(operation),
    );
    return operation;
  }
  async write(storage: ISqlStorage, operation: AuthorNoteOperation) {
    const commit = createEmptySqlCommit(
      storage.getRevision(),
      `author-note-${operation.type}`,
    );
    commit.idempotencyKey = v4();
    commit.authorNotes = [operation];
    return commitSqlChanges(storage, commit);
  }
  async list(): Promise<readonly GlobalAuthorNote[]> {
    const storage = this.requireStorage();
    const generation = this.generation;
    const rows = await storage.listGlobalAuthorNotes();
    this.assertCurrent(storage, generation);
    return rows.map((row) => new NoteObject(this, storage, generation, row));
  }
  async get(id: string): Promise<GlobalAuthorNote | null> {
    const storage = this.requireStorage();
    const generation = this.generation;
    const row = await storage.getGlobalAuthorNote(id);
    this.assertCurrent(storage, generation);
    return row ? new NoteObject(this, storage, generation, row) : null;
  }
  create(name: string, content = ""): Promise<GlobalAuthorNote> {
    const storage = this.requireStorage();
    const generation = this.generation;
    const id = v4();
    return this.track(
      this.write(storage, { type: "create", id, name, content }).then(
        (result) => {
          const saved = result.authorNotes?.find((row) => row.id === id);
          if (!saved) throw new Error("Missing committed author note metadata");
          return new NoteObject(
            this,
            storage,
            generation,
            { id, name, updatedAt: saved.updatedAt },
            saved.contentHash,
          );
        },
      ),
    );
  }
  rename(id: string, name: string): Promise<void> {
    return this.track(
      this.write(this.requireStorage(), { type: "rename", id, name }).then(
        () => undefined,
      ),
    );
  }
  remove(id: string): Promise<void> {
    return this.track(
      this.write(this.requireStorage(), { type: "remove", id }).then(
        () => undefined,
      ),
    );
  }
  getAllowScriptWrite(): Promise<boolean> {
    return this.requireStorage().getGlobalAuthorNoteScriptWrite();
  }
  setAllowScriptWrite(allowScriptWrite: boolean): Promise<void> {
    return this.track(
      this.write(this.requireStorage(), {
        type: "settings",
        allowScriptWrite,
      }).then(() => undefined),
    );
  }
  /** Script writes keep the caller's read hash and recheck permission inside SQL's transaction. */
  setScriptContent(note: GlobalAuthorNote, content: string): Promise<void> {
    if (!(note instanceof NoteObject))
      throw new Error("Invalid author note object");
    return note.save(content, { script: true });
  }
  async waitForPendingWrites(): Promise<void> {
    await Promise.all([...this.writes]);
  }
  async dispose(): Promise<void> {
    await this.waitForPendingWrites();
    this.storage = null;
    this.generation++;
  }
}
export const globalAuthorNoteStore = new SqlGlobalAuthorNoteStore();
