import { createEmptySqlCommit } from "../../storage/sql/sqlCommit";
import type { ISqlStorage } from "@risuai/storage-core/sqlStorage";
import { describe, expect, it, vi } from "vitest";
import {
  makeHarness,
  makeWebStorage,
  makeTauriStorage,
  makeCapacitorStorage,
} from "../../storage/sql/sqlite/sqliteTestHarness";
import schema from "@risuai/storage-sqlite/schema/schema.sql?raw";
import {
  SqlGlobalAuthorNoteStore,
  globalAuthorNoteStore,
} from "./globalAuthorNoteStore";
import {
  hashAuthorNote,
  AuthorNoteError,
  NO_AUTHOR_NOTE,
} from "@risuai/protocol/src/authorNotes.ts";
import { buildFullDatabase } from "../../storage/sql/sqlite/sqliteTestFixtures";
import {
  AuthorNoteEditor,
  failedAuthorNoteDrafts,
} from "../../authorNoteEditor";
import { NoteSource, readNote, materializeChatNote } from "../../authorNote";
import { characterStore } from "./characterStore.svelte";
import { exportPortableDatabaseStream } from "../../storage/backup/portableDatabaseStream";
import { hasPortableDatabaseStreamRestore } from "../../storage/backup/portableDatabaseStreamRestore";
import { get } from "svelte/store";

describe.each([
  { name: "web", make: makeWebStorage },
  { name: "tauri", make: makeTauriStorage },
  { name: "android", make: makeCapacitorStorage },
])("global author notes: $name", ({ make }) => {
  async function setup() {
    const harness = makeHarness<ISqlStorage>(make, schema);
    const store = new SqlGlobalAuthorNoteStore();
    await store.init(harness.storage);
    return { ...harness, store };
  }
  function blockMetadataRead(storage: ISqlStorage) {
    const readMetadata = storage.getGlobalAuthorNote.bind(storage);
    let finishRead!: () => void;
    let readStarted!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    vi.spyOn(storage, "getGlobalAuthorNote").mockImplementationOnce(
      async (id) => {
        const metadata = await readMetadata(id);
        readStarted();
        await blocked;
        return metadata;
      },
    );
    return { started, finishRead };
  }
  it("queries metadata without content, keeps content uncached, and waits for committed writes", async () => {
    const { store, storage, queryLog: log } = await setup();
    const note = await store.create("same", " \n\ud55c\uae00\ud83d\ude80\n ");
    await store.create("same");
    expect(note.contentHash).toBe(
      await hashAuthorNote(" \n\ud55c\uae00\ud83d\ude80\n "),
    );
    log.clear();
    const list = await store.list();
    const loaded = (await store.get(note.id))!;
    expect(loaded.contentHash).toBeNull();
    expect(list).toHaveLength(3);
    expect(log.entries.every((entry) => !/\bcontent\b/.test(entry.sql))).toBe(
      true,
    );
    await loaded.getContent();
    await loaded.setContent("persisted");
    expect((await storage.readGlobalAuthorNote(note.id))?.content).toBe(
      "persisted",
    );
    expect(await note.getContent()).toBe("persisted");
    expect("content" in loaded).toBe(false);
  });
  it("sees metadata renamed or deleted by another client", async () => {
    const { store, storage } = await setup();
    const other = new SqlGlobalAuthorNoteStore();
    await other.init(storage);
    const note = await store.create("before", "content");
    const reads = vi.spyOn(storage, "getGlobalAuthorNote");
    const [first, second] = await Promise.all([
      store.get(note.id),
      store.get(note.id),
    ]);
    expect(first?.name).toBe("before");
    expect(second).not.toBe(first);
    expect((await store.get(note.id))?.name).toBe("before");
    expect(reads).toHaveBeenCalledTimes(1);

    await other.rename(note.id, "after");
    expect((await store.get(note.id))?.name).toBe("after");
    expect(reads).toHaveBeenCalledTimes(2);

    await other.remove(note.id);
    expect(await store.get(note.id)).toBeNull();
    expect(reads).toHaveBeenCalledTimes(3);
  });
  it.each(["rename", "remove"])(
    "discards an old in-flight result after another client's %s",
    async (operation) => {
      const { store, storage } = await setup();
      const other = new SqlGlobalAuthorNoteStore();
      await other.init(storage);
      const note = await store.create("before");
      const { started, finishRead } = blockMetadataRead(storage);
      const pending = store.get(note.id);
      await started;
      if (operation === "rename") {
        await other.rename(note.id, "after");
      } else {
        await other.remove(note.id);
      }
      const current = await store.get(note.id);
      finishRead();
      const late = await pending;
      if (operation === "rename") {
        expect(current?.name).toBe("after");
        expect(late?.name).toBe("after");
        expect((await store.get(note.id))?.name).toBe("after");
      } else {
        expect(current).toBeNull();
        expect(late).toBeNull();
        expect(await store.get(note.id)).toBeNull();
      }
    },
  );
  it("finishes in-flight reads when concurrent misses exceed cache capacity", async () => {
    const { store, storage } = await setup();
    const note = await store.create("keep reading");
    const { started, finishRead } = blockMetadataRead(storage);
    const pending = store.get(note.id);
    await started;
    const misses = await Promise.all(
      Array.from({ length: 256 }, (_, index) => store.get(`missing-${index}`)),
    );
    finishRead();
    expect((await pending)?.name).toBe("keep reading");
    expect(misses.every((note) => note === null)).toBe(true);
  });
  it.each(["reinitialization", "disposal"])(
    "rejects metadata reads that finish after storage %s",
    async (transition) => {
      const { store, storage } = await setup();
      const note = await store.create("old database");
      const { started, finishRead } = blockMetadataRead(storage);
      const pending = expect(store.get(note.id)).rejects.toMatchObject({
        code: "disposed",
      });
      await started;
      if (transition === "reinitialization") {
        const next = makeHarness<ISqlStorage>(make, schema);
        await store.init(next.storage);
      } else {
        await store.dispose();
      }
      finishRead();
      await pending;
      if (transition === "reinitialization") {
        expect(await store.get(note.id)).toBeNull();
      } else {
        await expect(store.get(note.id)).rejects.toMatchObject({
          code: "disposed",
        });
      }
    },
  );
  it("rejects unread writes, conflicts, deleted writes and protected None, while allowing explicit overwrite", async () => {
    const { store } = await setup();
    const initial = await store.create("note", "old");
    const a = (await store.get(initial.id))!;
    const b = (await store.get(initial.id))!;
    await expect(b.setContent("unread")).rejects.toMatchObject({
      code: "unread",
    });
    await Promise.all([a.getContent(), b.getContent()]);
    const oldHash = b.contentHash;
    await a.setContent("first");
    await expect(b.setContent("second")).rejects.toMatchObject({
      code: "conflict",
    });
    expect(b.contentHash).toBe(oldHash);
    await b.setContent("second", { force: true });
    expect(await a.getContent()).toBe("second");
    await store.remove(initial.id);
    await expect(
      b.setContent("resurrect", { force: true }),
    ).rejects.toMatchObject({ code: "missing" });
    await expect(b.getContent()).rejects.toMatchObject({ code: "missing" });
    const none = (await store.get(NO_AUTHOR_NOTE))!;
    expect(await none.getContent()).toBe("");
    await expect(none.setContent("x", { force: true })).rejects.toMatchObject({
      code: "protected",
    });
    await expect(store.rename(NO_AUTHOR_NOTE, "x")).rejects.toMatchObject({
      code: "protected",
    });
    await expect(store.remove(NO_AUTHOR_NOTE)).rejects.toMatchObject({
      code: "protected",
    });
  });
  it("serializes object calls and keeps rename/content updates independent", async () => {
    const { store } = await setup();
    const note = await store.create("before", "0");
    const writing = note.setContent("1");
    const reading = note.getContent();
    await writing;
    expect(await reading).toBe("1");
    await store.rename(note.id, "after");
    await note.setContent("2");
    const loaded = (await store.get(note.id))!;
    expect(loaded.name).toBe("after");
    expect(await loaded.getContent()).toBe("2");
    await store.dispose();
    await expect(note.getContent()).rejects.toMatchObject({ code: "disposed" });
  });
  it("checks script permission at commit and keeps the caller's read hash", async () => {
    const { store } = await setup();
    const note = await store.create("script", "old");
    expect(await store.getAllowScriptWrite()).toBe(false);
    await expect(store.setScriptContent(note, "blocked")).rejects.toMatchObject(
      { code: "script-blocked" },
    );
    await store.setAllowScriptWrite(true);
    await store.setScriptContent(note, "allowed");
    await store.setScriptContent(note, "again");
    const other = (await store.get(note.id))!;
    await other.getContent();
    await other.setContent("user edit");
    await expect(
      store.setScriptContent(note, "lost update"),
    ).rejects.toMatchObject({ code: "conflict" });
    await store.setAllowScriptWrite(false);
    await expect(
      store.setScriptContent(other, "blocked again"),
    ).rejects.toMatchObject({ code: "script-blocked" });
  });
  it("replays an acknowledged request without another revision or hash conflict", async () => {
    const { storage, store } = await setup();
    const note = await store.create("receipt", "old");
    const commit = createEmptySqlCommit(
      storage.getRevision(),
      "author-note-content",
    );
    commit.idempotencyKey = "request-1";
    commit.authorNotes = [
      {
        type: "content",
        id: note.id,
        content: "once",
        expectedHash: note.contentHash,
      },
    ];
    const result = await storage.commit(commit);
    await store.create("another");
    const revision = storage.getRevision();
    expect(await storage.commit(commit)).toMatchObject(result);
    expect(storage.getRevision()).toBe(revision);
    await expect(
      storage.commit({
        ...commit,
        authorNotes: [
          {
            ...commit.authorNotes[0],
            type: "content",
            content: "changed",
            id: note.id,
            expectedHash: note.contentHash,
          },
        ],
      }),
    ).rejects.toThrow("idempotency key reused");
  });
  it("round-trips snapshots and bounded streaming backups, recomputing imported hashes", async () => {
    const { store, storage } = await setup();
    const database = buildFullDatabase();
    database.globalAuthorNotes = [
      {
        id: "imported",
        name: "backup",
        content: "body",
        contentHash: "bad hash",
        updatedAt: 123,
      },
    ];
    database.globalAuthorNoteSettings = { allowScriptWrite: true };
    database.characters[0].chats[0].globalAuthorNoteId = "imported";
    await storage.replaceDatabase(database);
    expect((await storage.readGlobalAuthorNote("imported"))?.contentHash).toBe(
      await hashAuthorNote("body"),
    );
    const snapshot = (await storage.exportDatabaseSnapshot())!.database!;
    expect(
      snapshot.globalAuthorNotes?.find((note) => note.id === "imported"),
    ).toMatchObject({ content: "body", updatedAt: 123 });
    expect(snapshot.characters[0].chats[0].globalAuthorNoteId).toBe("imported");
    const fragments: any[] = [];
    const manifest = await exportPortableDatabaseStream(
      storage,
      {
        writeFragment: async (fragment) => {
          fragments.push(fragment);
        },
        writeColdStorage: async () => undefined,
      },
      { fragmentRecords: 2 },
    );
    const target = await setup();
    expect(hasPortableDatabaseStreamRestore(target.storage)).toBe(true);
    if (!hasPortableDatabaseStreamRestore(target.storage))
      throw new Error("Missing restore");
    const session = await target.storage.beginPortableDatabaseStreamRestore();
    for (const fragment of fragments) await session.writeFragment(fragment);
    await session.finish(manifest);
    expect(await target.store.getAllowScriptWrite()).toBe(true);
    expect(await (await target.store.get("imported"))!.getContent()).toBe(
      "body",
    );
    expect(
      (await target.storage.exportDatabaseSnapshot())?.database?.characters[0]
        .chats[0].globalAuthorNoteId,
    ).toBe("imported");
    await storage.replaceDatabase(buildFullDatabase());
    expect((await store.list()).map((note) => note.id)).toEqual([
      NO_AUTHOR_NOTE,
    ]);
    expect(await store.getAllowScriptWrite()).toBe(false);
  });
  it("applies ordered note operations atomically, including queued native transactions", async () => {
    const { storage } = await setup();
    const commit = createEmptySqlCommit(
      storage.getRevision(),
      "author-note-content",
    );
    commit.authorNotes = [
      { type: "create", id: "compound", name: "initial", content: "0" },
      { type: "rename", id: "compound", name: "renamed" },
      { type: "settings", allowScriptWrite: true },
      {
        type: "content",
        id: "compound",
        content: "1",
        expectedHash: await hashAuthorNote("0"),
        script: true,
      },
      {
        type: "content",
        id: "compound",
        content: "2",
        expectedHash: await hashAuthorNote("1"),
      },
    ];
    await storage.commit(commit);
    expect(await storage.readGlobalAuthorNote("compound")).toMatchObject({
      name: "renamed",
      content: "2",
    });
    const failing = createEmptySqlCommit(
      storage.getRevision(),
      "author-note-content",
    );
    failing.authorNotes = [
      { type: "rename", id: "compound", name: "must roll back" },
      {
        type: "content",
        id: "compound",
        content: "stale",
        expectedHash: await hashAuthorNote("0"),
      },
    ];
    await expect(storage.commit(failing)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await storage.readGlobalAuthorNote("compound")).toMatchObject({
      name: "renamed",
      content: "2",
    });
  });
  it("selects stable chat targets and preserves local text, missing references and portable exports", async () => {
    const { storage } = await setup();
    const database = buildFullDatabase();
    await storage.replaceDatabase(database);
    characterStore.init(database.characters, storage);
    await globalAuthorNoteStore.init(storage);
    const note = await globalAuthorNoteStore.create("shared", "source");
    const char = characterStore.characters[0];
    const chat = char.chats[0];
    chat.note = "local retained";
    const target = { characterId: char.chaId!, chatId: chat.id! };
    const group = characterStore.characters[1];
    group.type = "group";
    group.chats.push({
      ...char.chats[1],
      id: "group-chat",
      note: "group local",
      message: [],
    });
    const groupTarget = { characterId: group.chaId!, chatId: "group-chat" };
    await NoteSource.set(groupTarget, { mode: "global", noteId: note.id });
    await NoteSource.set(target, { mode: "global", noteId: note.id });
    expect(await readNote(chat)).toBe("source");
    expect(chat.note).toBe("local retained");
    expect(char.chats[1].globalAuthorNoteId).toBeUndefined();
    expect(await readNote(group.chats[0])).toBe("source");
    expect(group.chats[0].note).toBe("group local");
    expect(await materializeChatNote(chat)).toMatchObject({ note: "source" });
    expect(
      (await materializeChatNote(chat)).globalAuthorNoteId,
    ).toBeUndefined();
    await globalAuthorNoteStore.remove(note.id);
    expect(await readNote(chat)).toBe("");
    await characterStore.flush();
    expect(chat.globalAuthorNoteId).toBe(NO_AUTHOR_NOTE);
    expect(group.chats[0].globalAuthorNoteId).toBe(NO_AUTHOR_NOTE);
    await NoteSource.set(target, { mode: "local" });
    expect(await readNote(chat)).toBe("local retained");
    await characterStore.flush();
    characterStore.dispose();
    await globalAuthorNoteStore.dispose();
  });
});

describe("author note editing sessions", () => {
  it("debounces at 100ms, preserves input during saves, and flushes the final draft on detach", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const note = {
      id: "n",
      name: "n",
      updatedAt: 0,
      contentHash: "hash",
      getContent: async () => "old",
      setContent: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        )
        .mockResolvedValue(undefined),
    };
    const editor = new AuthorNoteEditor(note);
    await editor.load();
    editor.input("first");
    await vi.advanceTimersByTimeAsync(99);
    expect(note.setContent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    editor.input("second");
    const closing = editor.detach();
    release();
    await closing;
    expect(note.setContent.mock.calls.map(([value]) => value)).toEqual([
      "first",
      "second",
    ]);
    expect(editor.draft).toBe("");
    vi.useRealTimers();
  });
  it("retains failed drafts after unmount until explicit recovery", async () => {
    const note = {
      id: "failed",
      name: "failed",
      updatedAt: 0,
      contentHash: "hash",
      getContent: async () => "stored",
      setContent: vi
        .fn()
        .mockRejectedValueOnce(new AuthorNoteError("conflict"))
        .mockResolvedValue(undefined),
    };
    const editor = new AuthorNoteEditor(note);
    await editor.load();
    editor.input("draft");
    await editor.detach();
    expect(editor.draft).toBe("draft");
    expect(get(failedAuthorNoteDrafts)).toContain(editor);
    await editor.overwrite();
    expect(note.setContent).toHaveBeenLastCalledWith("draft", { force: true });
    expect(get(failedAuthorNoteDrafts)).not.toContain(editor);
  });
});
