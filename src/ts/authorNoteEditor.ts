import { writable } from "svelte/store";
import type { GlobalAuthorNote } from "./stores/domain/globalAuthorNoteStore";

/** Drafts and debounce belong to editing sessions, never to the SQL store. */
export class AuthorNoteEditor {
  draft = "";
  private saved = "";
  error: unknown = null;
  detached = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> | null = null;
  private ready = false;
  private loading: Promise<void> | null = null;
  get isReady() {
    return this.ready;
  }
  get hasUnsavedChanges() {
    return this.ready && (this.draft !== this.saved || this.pending !== null);
  }
  constructor(
    readonly note: GlobalAuthorNote,
    private readonly changed: () => void = () => undefined,
  ) {
    editors.add(this);
  }
  private notify() {
    this.changed();
    failedAuthorNoteDrafts.set(
      [...editors].filter((editor) => editor.detached && editor.error),
    );
  }
  load(): Promise<void> {
    const operation = this.note
      .getContent()
      .then((content) => {
        this.draft = this.saved = content;
        this.ready = true;
        this.notify();
      })
      .finally(() => {
        this.loading = null;
      });
    this.loading = operation;
    return operation;
  }
  input(content: string) {
    this.draft = content;
    if (this.timer) clearTimeout(this.timer);
    if (!this.error)
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush().catch(() => undefined);
      }, 100);
    this.notify();
  }
  async flush(force = false): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.loading) await this.loading.catch(() => undefined);
    if (this.pending) {
      await this.pending;
      return this.flush(force);
    }
    if (this.error && !force) throw this.error;
    if (!this.ready || (!force && this.draft === this.saved)) return;
    const draft = this.draft;
    this.pending = this.note
      .setContent(draft, { force })
      .then(() => {
        this.saved = draft;
        this.error = null;
      })
      .catch((error) => {
        this.error = error;
        throw error;
      })
      .finally(() => {
        this.pending = null;
        this.notify();
      });
    await this.pending;
    if (this.draft !== this.saved) await this.flush();
  }
  async retry() {
    this.error = null;
    this.notify();
    await this.flush();
  }
  async reload() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending) await this.pending.catch(() => undefined);
    const content = await this.note.getContent();
    this.draft = this.saved = content;
    this.error = null;
    this.ready = true;
    this.notify();
    if (this.detached) this.release();
  }
  async overwrite() {
    await this.flush(true);
    if (this.detached) this.release();
  }
  async detach() {
    this.detached = true;
    try {
      await this.flush();
      this.release();
    } catch {
      this.notify();
    }
  }
  /** Only call after the user explicitly confirms discarding this draft. */
  discard() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.error = null;
    this.release();
  }
  private release() {
    editors.delete(this);
    this.draft = this.saved = "";
    this.notify();
  }
}
const editors = new Set<AuthorNoteEditor>();
export const failedAuthorNoteDrafts = writable<AuthorNoteEditor[]>([]);
export async function flushAuthorNoteEditors(): Promise<void> {
  await Promise.all([...editors].map((editor) => editor.flush()));
}

export function hasUnsavedAuthorNoteDrafts(): boolean {
  return [...editors].some((editor) => editor.hasUnsavedChanges);
}
