// @vitest-environment happy-dom
/**
 * Shared behavioral contract suite for the SQLite storage backends.
 *
 * Every backend (web WASM worker, Tauri plugin-sql, Capacitor native bridge)
 * runs the SAME assertions against a real in-process node:sqlite database.
 * The harness drives each backend through its real production code path, so
 * SQL, codecs, and lazy-loading behavior are validated for parity.
 *
 * Lazy-loading contracts asserted here are the regression guard for the
 * storage optimization work: if a change makes a shallow load hydrate
 * deferred settings, or makes message loading issue per-message queries,
 * these tests fail.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createEmptySqlCommit,
  SqlRevisionConflictError,
  type SqlCommit,
} from "./sqlCommit";
import type { ISqlStorage } from "./ISqlStorage";
import {
  DEFERRED_STARTUP_SETTING_KEYS,
  PROMPT_SETTING_KEYS,
} from "./sqlDeferredSettings";
import sqliteSchemaSql from "./sqlite-schema.sql?raw";
import {
  flattenRelationalValue,
  type RelationalNodeRow,
} from "./relationalNodeCodec";
import {
  makeWebStorage,
  makeTauriStorage,
  makeCapacitorStorage,
  makeHarness,
  type QueryLog,
} from "./sqliteTestHarness";
import type { Database, character, Chat, Message } from "./schema";
import { installDatabase } from "./databaseLifecycle";
import { settingsStore } from "../stores/domain/settingsStore.svelte";

type MakeStorage = (database: DatabaseSync) => ISqlStorage;

const backendFactories: { name: string; make: MakeStorage }[] = [
  { name: "WebSqliteStorage", make: makeWebStorage as MakeStorage },
  { name: "TauriSqliteStorage", make: makeTauriStorage as MakeStorage },
  { name: "CapacitorSqliteStorage", make: makeCapacitorStorage as MakeStorage },
];

// ── Fixture builders ─────────────────────────────────────────────────

export { buildFullDatabase, makeMessage } from "./sqliteTestFixtures";

import { buildFullDatabase, makeMessage } from "./sqliteTestFixtures";

async function seed(
  storage: ISqlStorage,
  database: Database = buildFullDatabase(),
): Promise<Database> {
  const ok = await storage.replaceDatabase(database);
  if (!ok) throw new Error("replaceDatabase failed");
  return database;
}

function makeFreshHarness(make: MakeStorage) {
  return makeHarness(make, sqliteSchemaSql);
}

// ── Contract suites ──────────────────────────────────────────────────

describe.each(backendFactories)("$name contracts", ({ make }) => {
  it("round-trips a full database through replaceDatabase + loadDatabase", async () => {
    const { storage, database } = makeFreshHarness(make);
    const source = await seed(storage);

    const loaded = await storage.loadDatabase({ shallow: false });
    expect(loaded?.status).toBe("ready");
    const db = loaded?.database as any;

    expect(db.username).toBe("tester");
    expect(db.language).toBe("en");
    expect(db.theme).toBe("dark");
    expect(db.characters[0].chats[0].message.map((m: Message) => m.data)).toEqual([
      "one",
      "two",
    ]);
    expect(db.characters[0].chats[0].messagesLoaded).toBe(true);
    expect(db.characters[0].chats[0].messagesFullyLoaded).toBe(true);
    expect(db.characters[0].chats[0].messageOffset).toBe(0);
    expect(db.characters[0].chats[0].messageTotal).toBe(2);
    expect(await storage.loadPersonas()).toEqual(source.personas);
    expect(await storage.loadLorebooks()).toEqual(source.loreBook);
    expect(await storage.loadModules()).toEqual(source.modules);
    expect(await storage.loadScripts()).toEqual(source.globalscript);

    const char = await storage.loadCharacter("char-1");
    expect(char?.name).toBe("Alpha");
    expect(char?.detailsLoaded).toBe(true);
    expect(char?.chats.map((c) => c.id)).toEqual(["chat-1", "chat-2"]);

    const chat = await storage.loadChat("chat-1");
    expect(chat?.message.map((m) => m.data)).toEqual(["one", "two"]);
    expect(chat?.message[0].generationInfo?.model).toBe("test-model");
    expect(chat?.message[0].promptInfo?.promptName).toBe("preset");
    database.close();
  });

  it("preserves relational codec edge cases end to end", async () => {
    const { storage, database } = makeFreshHarness(make);
    const exotic = {
      unicode: "한국어 🎴 émigré",
      nul: "with\0nul",
      surrogate: "unpaired\ud800surrogate",
      emptyObject: {},
      emptyArray: [],
      falsy: [false, 0, "", null],
      nested: { deep: { deeper: [[[[1]]]] } },
      nan: Number.NaN,
      infinity: Number.POSITIVE_INFINITY,
    };
    const commit = createEmptySqlCommit(0, "seed-exotic");
    commit.root.upserts.push({ key: "exotic", value: exotic });
    await storage.commit(commit);
    expect(await (storage as any).loadSettingValue("exotic")).toEqual(exotic);
    database.close();
  });

  it("shallow load keeps characters, chats, and deferred settings lazy", async () => {
    const { storage, database, queryLog } = makeFreshHarness(make);
    const source = await seed(storage);
    queryLog.clear();

    const loaded = await storage.loadDatabase({ shallow: true });
    const db = loaded?.database as any;
    expect(loaded?.status).toBe("ready");
    expect(db.isSql).toBe(true);

    // Characters are metadata shells.
    expect(db.characters).toHaveLength(2);
    expect(db.characters[0]).toMatchObject({
      chaId: "char-1",
      name: "Alpha",
      detailsLoaded: false,
    });
    expect(db.characters[0].chats).toEqual([]);
    expect(db.characters[0].message).toBeUndefined();

    // Storage returns plain shallow data now; deferred domains are omitted
    // instead of being hidden behind the deleted database adapter proxy.
    expect(Object.prototype.hasOwnProperty.call(db, "personas")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(db, "loreBook")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(db, "modules")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(db, "globalscript")).toBe(
      false,
    );
    expect(typeof db.isDomainLoaded).toBe("undefined");

    // Lazy loading contract: every setting-node read in a shallow load must
    // exclude the deferred keys; plugin storage must not be read at all.
    const settingNodeQueries = queryLog.where((sql) =>
      sql.includes("setting_extension_nodes"),
    );
    expect(settingNodeQueries.length).toBeGreaterThan(0);
    for (const query of settingNodeQueries) {
      expect(
        query.sql.includes("NOT IN"),
        `shallow load must defer startup settings, got: ${query.sql}`,
      ).toBe(true);
    }
    expect(queryLog.touching("plugin_custom_storage")).toBe(0);

    // Per-message chat node hydration must not happen during shallow load.
    expect(queryLog.touching("chat_extension_nodes")).toBe(0);
    expect(queryLog.touching("message_extension_nodes")).toBe(0);

    // The domain store owns lazy hydration: defaults are immediately usable,
    // then the targeted storage value replaces them without becoming a write.
    installDatabase(db as Database, storage);
    queryLog.clear();
    const live = settingsStore.state;
    expect(queryLog.touching("setting_extension_nodes")).toBe(0);
    expect(live.loreBook).toEqual([
      { name: "My First LoreBook", data: [] },
    ]);
    await settingsStore.ensureDeferredKey("loreBook");
    expect(settingsStore.state.loreBook).toEqual(source.loreBook);
    expect(queryLog.touching("setting_extension_nodes")).toBeGreaterThan(0);
    settingsStore.dispose();
    database.close();
  });

  it("shallow load defers every DEFERRED_STARTUP_SETTING_KEYS entry", async () => {
    const { storage, database } = makeFreshHarness(make);
    const db = buildFullDatabase();
    // Give every deferred key a distinctive payload to detect leakage.
    for (const key of PROMPT_SETTING_KEYS) {
      (db as any)[key] = `leaky-${key}`;
    }
    await seed(storage, db);

    const loaded = (await storage.loadDatabase({ shallow: true }))
      ?.database as any;
    for (const key of DEFERRED_STARTUP_SETTING_KEYS) {
      if (key === "pluginCustomStorage") continue;
      expect(
        Object.prototype.hasOwnProperty.call(loaded, key),
        `deferred key '${key}' must be absent from the raw shallow snapshot`,
      ).toBe(false);
    }

    installDatabase(loaded as Database, storage);
    expect(settingsStore.state.mainPrompt).not.toBe("leaky-mainPrompt");
    await settingsStore.ensureDeferredKey("mainPrompt");
    expect(settingsStore.state.mainPrompt).toBe("leaky-mainPrompt");
    settingsStore.dispose();
    database.close();
  });

  it("loads character details and chat messages on demand", async () => {
    const { storage, database, queryLog } = makeFreshHarness(make);
    await seed(storage);
    queryLog.clear();

    const character = await storage.loadCharacter("char-1");
    expect(character?.detailsLoaded).toBe(true);
    expect(character?.chats).toHaveLength(2);
    expect(character?.chats[0].messagesLoaded).toBe(false);
    expect(character?.chats[0].message).toEqual([]);
    expect(queryLog.touching("message_extension_nodes")).toBe(0);

    const chat = await storage.loadChat("chat-1", { messageLimit: 1 });
    expect(chat?.message.map((m) => m.data)).toEqual(["two"]);
    expect(chat?.messageOffset).toBe(1);
    expect(chat?.messageTotal).toBe(2);
    expect(chat?.messagesFullyLoaded).toBe(false);

    const fullChat = await storage.loadChat("chat-1");
    expect(fullChat?.message.map((m) => m.data)).toEqual(["one", "two"]);
    expect(fullChat?.messagesFullyLoaded).toBe(true);
    database.close();
  });

  it("keeps message identity and order stable across load paths", async () => {
    const { storage, database } = makeFreshHarness(make);
    await seed(storage);

    const viaChat = await storage.loadChat("chat-1");
    const viaMessages = await storage.loadChatMessages("chat-1");
    const page = await storage.loadChatMessagePage("chat-1", undefined, 1);

    expect(viaChat?.message.map((m) => m.chatId)).toEqual(["m1", "m2"]);
    expect(viaMessages.map((m) => m.chatId)).toEqual(["m1", "m2"]);
    expect(page.messages.map((m) => m.chatId)).toEqual(["m2"]);
    expect(page.total).toBe(2);
    expect(page.offset).toBe(1);
    expect(page.hasMore).toBe(true);
    database.close();
  });

  it("satisfies paging invariants across message pages", async () => {
    const { storage, database } = makeFreshHarness(make);
    const db = buildFullDatabase();
    db.characters[0].chats[0].message = Array.from({ length: 7 }, (_, i) =>
      makeMessage(`pg-${i}`, i % 2 ? "char" : "user", `p${i}`),
    );
    await seed(storage, db);

    const all = await storage.loadChatMessages("chat-1");
    expect(all).toHaveLength(7);

    // Pages walk oldest-ward: each request returns the `limit` messages that
    // end at `before` (exclusive). Callers prepend each page to the buffer.
    const pages: Message[][] = [];
    let before: number | undefined;
    let hasMore = true;
    while (hasMore && pages.length < 10) {
      const page = await storage.loadChatMessagePage("chat-1", before, 3);
      pages.push(page.messages);
      before = page.offset;
      hasMore = page.hasMore;
    }
    // Reconstruct the full history the way the UI does: newest page first,
    // then prepend each older page.
    const reconstructed = [...pages[0]];
    for (let i = 1; i < pages.length; i++) {
      reconstructed.unshift(...pages[i]);
    }
    expect(reconstructed.map((m) => m.data)).toEqual([
      "p0",
      "p1",
      "p2",
      "p3",
      "p4",
      "p5",
      "p6",
    ]);
    // Newest page holds the latest messages.
    expect(pages[0].map((m) => m.data)).toEqual(["p4", "p5", "p6"]);
    // Oldest page holds the beginning and reports no more history.
    expect(pages.at(-1)!.map((m) => m.data)).toEqual(["p0"]);
    expect(before).toBe(0);
    database.close();
  });

  it("rejects commits with stale revisions and advances on success", async () => {
    const { storage, database } = makeFreshHarness(make);
    const commit = createEmptySqlCommit(0, "seed-rev");
    commit.root.upserts.push({ key: "counter", value: 1 });
    await storage.commit(commit);
    expect(storage.getRevision()).toBe(1);

    const stale = createEmptySqlCommit(0, "stale");
    stale.root.upserts.push({ key: "counter", value: 2 });
    await expect(storage.commit(stale)).rejects.toBeInstanceOf(
      SqlRevisionConflictError,
    );

    const next = createEmptySqlCommit(1, "next");
    next.root.upserts.push({ key: "counter", value: 3 });
    await expect(storage.commit(next)).resolves.toEqual({ revision: 2 });
    expect(await (storage as any).loadSettingValue("counter")).toBe(3);
    database.close();
  });

  it("character-touch commits do not rewrite extension nodes", async () => {
    const { storage, database, queryLog } = makeFreshHarness(make);
    await seed(storage);
    queryLog.clear();

    const touch = createEmptySqlCommit(1, "character-touch");
    touch.characterTouches = [{ id: "char-1", lastInteraction: 987654321 }];
    await storage.commit(touch);

    const rows = database
      .prepare(
        "SELECT last_interaction_time FROM characters WHERE id = 'char-1'",
      )
      .get() as { last_interaction_time: number };
    expect(rows.last_interaction_time).toBe(987654321);
    expect(
      queryLog.entries.some(
        (e) => e.kind === "run" && e.sql.includes("character_extension_nodes"),
      ),
    ).toBe(false);
    database.close();
  });

  it("replace-all commits wipe and rebuild the database", async () => {
    const { storage, database } = makeFreshHarness(make);
    await seed(storage);
    const replacement = buildFullDatabase();
    replacement.username = "replaced";
    replacement.characters = [];
    await storage.replaceDatabase(replacement as Database);

    const loaded = (await storage.loadDatabase({ shallow: false }))
      ?.database as any;
    expect(loaded.username).toBe("replaced");
    expect(loaded.characters).toEqual([]);
    const charCount = database
      .prepare("SELECT COUNT(*) AS count FROM characters")
      .get() as { count: number };
    expect(Number(charCount.count)).toBe(0);
    database.close();
  });

  it("messageLimit normalization guards LIMIT clauses", async () => {
    const { storage, database } = makeFreshHarness(make);
    await seed(storage);

    const zero = await storage.loadChat("chat-1", { messageLimit: 0 });
    expect(zero?.message).toHaveLength(1);
    expect(zero?.messageOffset).toBe(1);

    const negative = await storage.loadChat("chat-1", { messageLimit: -5 });
    expect(negative?.message).toHaveLength(1);
    database.close();
  });
});

// ── Generation-mode contract (metadata-stripped message loads) ───────

describe.each(backendFactories)("$name generation mode", ({ make }) => {
  it("omits prompt metadata but keeps message bodies in generation mode", async () => {
    const { storage, database } = makeFreshHarness(make);
    await seed(storage);

    const generation = await storage.loadChatMessages("chat-1", {
      mode: "generation",
    });
    expect(generation.map((m) => m.data)).toEqual(["one", "two"]);
    expect(generation.map((m) => m.role)).toEqual(["user", "char"]);
    expect(generation[0].time).toBe(1000);
    expect(generation[0].generationInfo?.model).toBe("test-model");
    expect(generation[0].promptInfo).toBeUndefined();

    const full = await storage.loadChatMessages("chat-1");
    expect(full[0].promptInfo?.promptName).toBe("preset");
    expect(full[0].generationInfo?.model).toBe("test-model");
    database.close();
  });

  it("does not read promptInfo nodes in generation mode", async () => {
    const { storage, database, queryLog } = makeFreshHarness(make);
    await seed(storage);
    queryLog.clear();

    await storage.loadChatMessages("chat-1", { mode: "generation" });
    expect(queryLog.touching("message_extension_nodes")).toBeLessThanOrEqual(2);
    database.close();
  });
});

// ── N+1 defense (activated in Phase 2) ───────────────────────────────

describe.each(backendFactories)("$name N+1 defense", ({ make }) => {
  it("loads 50 messages with a bounded number of queries", async () => {
    const { storage, database, queryLog } = makeFreshHarness(make);
    const db = buildFullDatabase();
    db.characters[0].chats[0].message = Array.from({ length: 50 }, (_, i) =>
      makeMessage(`bulk-${i}`, i % 2 ? "char" : "user", `bulk ${i}`),
    );
    await seed(storage, db);
    queryLog.clear();

    const messages = await storage.loadChatMessages("chat-1");
    expect(messages).toHaveLength(50);
    expect(
      queryLog.touching("message_extension_nodes"),
      "message loading must batch node reads (N+1 regression)",
    ).toBeLessThanOrEqual(2);
    database.close();
  });

  it("loads interactive selection without hydrating chat details", async () => {
    const { storage, database, queryLog } = makeFreshHarness(make);
    await seed(storage);
    queryLog.clear();

    const loader = (storage as any).loadCharacterForSelection?.bind(storage);
    if (!loader) {
      throw new Error(
        `${(storage as any).backendKind}: loadCharacterForSelection missing (Phase 3 contract)`,
      );
    }
    const character = await loader("char-1");
    expect(character?.name).toBe("Alpha");
    expect(character?.chats.map((c) => c.id)).toEqual(["chat-1", "chat-2"]);
    expect(character?.chats.every((c) => c.detailsLoaded === false)).toBe(true);
    expect(
      queryLog.touching("chat_extension_nodes"),
      "selection loader must not hydrate chat details",
    ).toBe(0);
    database.close();
  });
});
