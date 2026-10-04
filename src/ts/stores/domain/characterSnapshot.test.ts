// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import { get } from "svelte/store";
import sqliteSchemaSql from "@risuai/storage-sqlite/schema/schema.sql?raw";
import {
  makeHarness,
  makeWebStorage,
  makeTauriStorage,
  makeCapacitorStorage,
} from "../../storage/sql/sqlite/sqliteTestHarness";
import {
  buildFullDatabase,
  makeMessage,
} from "../../storage/sql/sqlite/sqliteTestFixtures";
import { characterStore } from "./characterStore.svelte";
import { messageStore } from "./messageStore.svelte";
import { setSqlStorageForTesting } from "../../storage/sql/sqlStorageFactory";
const {
  load: getPluginCharacter,
  loadAll: getPluginCharacters,
  save: setPluginCharacter,
  saveAll: replacePluginCharacters,
} = characterStore.snapshot;
const { load: getPluginChat, save: setPluginChat } =
  characterStore.snapshot.chat;
import { getV2PluginAPIs } from "../../plugins/plugins.svelte";
import { importChat } from "../../characters";
import * as util from "../../util";
import { selectedCharID } from "../../stores.svelte";
import type { DatabaseSync } from "node:sqlite";
import type { ISqlStorage } from "../../storage/sql/ISqlStorage";
import type {
  character,
  PortableDatabase,
  botPreset,
} from "../../storage/database/schema";

describe.each([
  { name: "Web", make: makeWebStorage },
  { name: "Tauri", make: makeTauriStorage },
  { name: "Android", make: makeCapacitorStorage },
])("$name plugin character compatibility", ({ make }) => {
  let storage: ISqlStorage;
  let close: () => void;
  let sql: DatabaseSync;

  beforeEach(async () => {
    const harness = makeHarness<ISqlStorage>(make, sqliteSchemaSql);
    storage = harness.storage;
    sql = harness.database;
    close = () => harness.database.close();
    const database = buildFullDatabase();
    const character = database.characters[0];
    character.chatPage = 0;
    character.chats[0].message = Array.from({ length: 14 }, (_, index) =>
      makeMessage(`m${index}`, index % 2 ? "char" : "user", `message ${index}`),
    );
    character.chats[0].scriptstate = { $plugin: "before" };
    character.chats[1].scriptstate = { $plugin: "second-before" };
    await storage.replaceDatabase(database);
    setSqlStorageForTesting(storage);
    messageStore.resetPersistenceForTesting();
    const startup = await storage.loadStartupData();
    characterStore.init(startup!.characters, storage);
    characterStore.select(0);
    selectedCharID.set(0);
    flushSync();
  });

  afterEach(async () => {
    await characterStore.flush();
    characterStore.dispose();
    messageStore.resetPersistenceForTesting();
    setSqlStorageForTesting(null);
    close();
    vi.restoreAllMocks();
  });

  async function loadResidentPage() {
    await characterStore.ensureCharacterDetails("char-1");
    const page = await storage.loadChat("chat-1", { messageLimit: 12 });
    characterStore.characters[0].chats[0] = page!;
    characterStore.select(0);
    flushSync();
    await characterStore.flush();
  }

  it("returns full absolute message indexes without hydrating resident history", async () => {
    await loadResidentPage();
    const resident = characterStore.characters[0].chats[0];
    resident.message[0].data = "newer in-memory edit";
    const snapshot = await getPluginChat(0, 0);
    expect(snapshot!.message).toHaveLength(14);
    expect(snapshot!.message[0].data).toBe("message 0");
    expect(snapshot!.message[2].data).toBe("newer in-memory edit");
    expect(snapshot!.message[12].role).toBe("user");
    expect(snapshot!.messageOffset).toBe(0);
    expect(resident.message).toHaveLength(12);
    expect(resident.messageOffset).toBe(2);
    snapshot!.message[12].data = "snapshot-only";
    expect(resident.message[10].data).toBe("message 12");
  });

  it("reads inactive histories without retaining them in the app", async () => {
    const residentChats = characterStore.characters[0].chats;
    expect(characterStore.characters[0].detailsLoaded).toBe(false);

    const snapshots = await getPluginCharacters();
    const snapshot = snapshots[0];
    expect(snapshot.chats[0].message).toHaveLength(14);
    expect(snapshot.chats[1].message[0].data).toBe("three");
    expect(snapshot.chats[1].scriptstate).toEqual({
      $plugin: "second-before",
    });
    expect(characterStore.characters[0].detailsLoaded).toBe(false);
    expect(characterStore.characters[0].chats).toBe(residentChats);
    expect(
      characterStore.characters[0].chats.every((chat) => !chat.message.length),
    ).toBe(true);
  });

  it("persists both chats' plugin state and old request tags through setCharacter", async () => {
    const apis = getV2PluginAPIs();
    const snapshot = await apis.getChar();
    snapshot!.chats[0].scriptstate!.$plugin = "after";
    snapshot!.chats[0].message[0].data += " <request-id>request-1</request-id>";
    snapshot!.chats[1].scriptstate!.$plugin = "second-after";
    await apis.setChar(snapshot!);

    const restored = await storage.loadChat("chat-1");
    expect(restored!.scriptstate).toEqual({ $plugin: "after" });
    expect(restored!.message[0].data).toContain("request-1");
    expect((await storage.loadChat("chat-2"))!.scriptstate).toEqual({
      $plugin: "second-after",
    });
    expect(characterStore.characters[0].chats[0].messagesLoaded).toBe(false);
    await characterStore.flush();
    characterStore.dispose();
    characterStore.init((await storage.loadStartupData())!.characters, storage);
    characterStore.select(0);
    const restarted = await apis.getChar();
    expect(restarted!.chats[0].scriptstate!.$plugin).toBe("after");
    expect(restarted!.chats[0].message[0].data).toContain("request-1");
    expect(restarted!.chats[1].scriptstate!.$plugin).toBe("second-after");
  });

  it("keeps pending character edits while reading an already hydrated character", async () => {
    await characterStore.ensureCharacterDetails("char-1");
    characterStore.characters[0].name = "unsaved local edit";
    const snapshot = await getPluginCharacter(0);
    expect(snapshot!.name).toBe("unsaved local edit");
  });

  it("restores prompt metadata omitted by lightweight generation loading", async () => {
    const chat = (await storage.loadChat("chat-1"))!;
    chat.message[0].promptInfo = {
      promptName: "plugin metadata",
      promptToggles: [],
    };
    await characterStore.ensureCharacterDetails("char-1");
    characterStore.characters[0].chats[0] = chat;
    await messageStore.updateMessage("chat-1", chat.message[0]);
    characterStore.characters[0].chats[0] = (await storage.loadChat("chat-1", {
      messageLimit: 12,
    }))!;
    await characterStore.ensureChatMessages("chat-1", {
      full: true,
      generation: true,
    });
    expect(
      characterStore.characters[0].chats[0].message[0].promptInfo,
    ).toBeUndefined();
    expect((await getPluginChat(0, 0))!.message[0].promptInfo!.promptName).toBe(
      "plugin metadata",
    );
    expect(
      characterStore.characters[0].chats[0].message[0].promptInfo,
    ).toBeUndefined();
  });

  it("persists chat state and arbitrary message changes together", async () => {
    const snapshot = await getPluginChat(0, 0);
    snapshot!.scriptstate!.$plugin = "after";
    snapshot!.message[12].data += " <request-id>request-12</request-id>";
    await setPluginChat(0, 0, snapshot!);
    const restored = await storage.loadChat("chat-1");
    expect(restored!.scriptstate!.$plugin).toBe("after");
    expect(restored!.message[12].data).toContain("request-12");
  });

  it("saves message deletion and insertion with stable IDs", async () => {
    const snapshot = await getPluginChat(0, 0);
    snapshot!.message.splice(0, 1);
    snapshot!.message.push({ role: "user", data: "new choice" });
    await setPluginChat(0, 0, snapshot!);
    const restored = await storage.loadChat("chat-1");
    expect(restored!.message[0].chatId).toBe("m1");
    expect(restored!.message.at(-1)!.data).toBe("new choice");
    expect(restored!.message.at(-1)!.chatId).toBeTruthy();
    expect(restored!.message.some((message) => message.chatId === "m0")).toBe(
      false,
    );
  });

  it("preserves unloaded messages when writing a partial page", async () => {
    await loadResidentPage();
    const partial = characterStore.getCharacterByIndex(0, { snapshot: true })!
      .chats[0];
    partial.message[0].data = "edited absolute message 2";
    await setPluginChat(0, 0, partial);
    const restored = await storage.loadChat("chat-1");
    expect(restored!.message).toHaveLength(14);
    expect(restored!.message[0].data).toBe("message 0");
    expect(restored!.message[2].data).toBe("edited absolute message 2");
    expect(characterStore.characters[0].chats[0].message).toHaveLength(12);
  });

  it("rewrites every chat and message row even when only plugin state changes", async () => {
    const snapshot = await getPluginCharacter(0);
    snapshot!.chats[0].scriptstate!.$plugin = "after";
    await characterStore.flush();
    const commit = vi.spyOn(storage, "commit");
    await setPluginCharacter(0, snapshot!);
    const pluginCommit = commit.mock.calls
      .map(([commit]) => commit)
      .find((commit) => commit.action === "snapshot-character");
    expect(pluginCommit!.chats).toHaveLength(2);
    expect(pluginCommit!.messages.map((message) => message.id)).toEqual(
      expect.arrayContaining(["m0", "m13"]),
    );
  });

  it("rejects failed writes without reporting or retaining an unsaved plugin state", async () => {
    const snapshot = await getPluginChat(0, 0);
    snapshot!.scriptstate!.$plugin = "after";
    await characterStore.flush();
    vi.spyOn(storage, "commit").mockRejectedValueOnce(
      new Error("disk unavailable"),
    );
    await expect(setPluginChat(0, 0, snapshot!)).rejects.toThrow(
      "disk unavailable",
    );
    expect((await storage.loadChat("chat-1"))!.scriptstate!.$plugin).toBe(
      "before",
    );
    expect((await getPluginChat(0, 0))!.scriptstate!.$plugin).toBe("before");
    await setPluginChat(0, 0, snapshot!);
    expect((await storage.loadChat("chat-1"))!.scriptstate!.$plugin).toBe(
      "after",
    );
  });

  it("rejects incomplete reads instead of returning a misleading partial array", async () => {
    await characterStore.ensureCharacterDetails("char-1");
    vi.spyOn(storage, "loadChat").mockRejectedValueOnce(
      new Error("read unavailable"),
    );
    await expect(getPluginChat(0, 0)).rejects.toThrow("read unavailable");
  });

  it("rejects a backend that returns an incomplete history for a full read", async () => {
    await loadResidentPage();
    const partial = characterStore.getCharacterByIndex(0, { snapshot: true })!
      .chats[0];
    vi.spyOn(storage, "loadChat").mockResolvedValueOnce(partial);
    await expect(getPluginChat(0, 0)).rejects.toThrow(
      "Cannot load complete chat",
    );
  });

  it("writes directly to an unhydrated character without deleting its history", async () => {
    expect(characterStore.characters[0].detailsLoaded).toBe(false);
    await setPluginChat(0, 0, {
      name: "Main",
      note: "notes",
      localLore: [],
      message: [],
      scriptstate: { $plugin: "direct-write" },
      detailsLoaded: false,
      messagesLoaded: false,
      messagesFullyLoaded: false,
    });
    const restored = await storage.loadChat("chat-1");
    expect(restored!.message).toHaveLength(14);
    expect(restored!.scriptstate!.$plugin).toBe("direct-write");
  });

  it("persists database character replacement without clearing unrelated settings", async () => {
    const snapshots = await getPluginCharacters();
    snapshots[0].chats[0].scriptstate!.$plugin = "via-database";
    snapshots[0].chats[0].message[12].data = "request from database setter";
    await getV2PluginAPIs().setDatabase({ characters: snapshots });
    const restored = await storage.loadChat("chat-1");
    expect(restored!.scriptstate!.$plugin).toBe("via-database");
    expect(restored!.message[12].data).toBe("request from database setter");
    expect(await storage.loadSettingKey("language")).toBe("en");
  });

  it("supports chat additions and removals in a character snapshot", async () => {
    const snapshot = await getPluginCharacter(0);
    snapshot!.chats.splice(1, 1);
    snapshot!.chats.push({
      name: "New",
      note: "",
      localLore: [],
      message: [{ role: "user", data: "new" }],
    });
    await setPluginCharacter(0, snapshot!);
    const restored = await storage.loadCharacter("char-1");
    expect(restored!.chats.map((chat) => chat.name)).toEqual(["Main", "New"]);
    expect(await storage.loadChat("chat-2")).toBeNull();
    expect(
      (await storage.loadChat(restored!.chats[1].id!))!.message[0].data,
    ).toBe("new");
  });

  it("continues two exported chats on a new bot and restores their next plugin state", async () => {
    const source = await getPluginCharacter(0);
    vi.spyOn(util, "selectSingleFile").mockResolvedValue({
      name: "all-chats.json",
      data: new TextEncoder().encode(
        JSON.stringify({
          type: "risuAllChats",
          ver: 2,
          data: source!.chats,
          folders: [],
        }),
      ),
    });
    await characterStore.ensureCharacterDetails("char-2");
    characterStore.select(1);
    selectedCharID.set(1);
    await importChat();
    const imported = await getPluginCharacter(1);
    expect(imported!.chats).toHaveLength(2);
    expect(imported!.chats[0].id).not.toBe("chat-1");
    imported!.chats[0].message[12].data +=
      " <request-id>imported-request</request-id>";
    imported!.chats[0].scriptstate!.$plugin = "continued-first";
    imported!.chats[1].scriptstate!.$plugin = "continued-second";
    await setPluginCharacter(1, imported!);
    await characterStore.flush();
    characterStore.dispose();
    characterStore.init((await storage.loadStartupData())!.characters, storage);
    const restarted = await getPluginCharacter(1);
    expect(restarted!.chats[0].message[12].data).toContain("imported-request");
    expect(restarted!.chats[0].scriptstate!.$plugin).toBe("continued-first");
    expect(restarted!.chats[1].scriptstate!.$plugin).toBe("continued-second");
    expect((await storage.loadChat("chat-1"))!.scriptstate!.$plugin).toBe(
      "before",
    );
  });

  it("preserves character order and handles additions and removals", async () => {
    const snapshot = await getPluginCharacter(0);
    const newCharacter = {
      ...snapshot!,
      chaId: "char-new",
      name: "New",
      chats: [],
    } as character;
    await replacePluginCharacters([newCharacter, snapshot!]);
    const startup = await storage.loadStartupData();
    expect(startup!.characters.map((character) => character.chaId)).toEqual([
      "char-new",
      "char-1",
    ]);
    expect(await storage.loadCharacter("char-2")).toBeNull();
    expect(characterStore.currentCharacter!.chaId).toBe("char-1");
  });
  async function restart() {
    flushSync();
    await characterStore.flush();
    characterStore.dispose();
    characterStore.init((await storage.loadStartupData())!.characters, storage);
    flushSync();
    return characterStore.snapshot.loadAll();
  }

  async function seedThreeCharacters() {
    characterStore.dispose();
    const fixture = buildFullDatabase() as PortableDatabase;
    fixture.botPresets = [{ name: "preserved preset" } as botPreset];
    fixture.plugins = [
      { name: "preserved plugin", script: "source", enabled: false } as never,
    ];
    fixture.characters[1].chats = [
      {
        id: "chat-b",
        name: "B",
        note: "",
        localLore: [],
        message: [makeMessage("b-message", "user", "B history")],
      },
    ];
    fixture.characters.push({
      ...fixture.characters[1],
      chaId: "char-3",
      name: "C",
      chats: [
        {
          id: "chat-c",
          name: "C",
          note: "",
          localLore: [],
          message: [makeMessage("c-message", "user", "C history")],
        },
      ],
    } as character);
    await storage.replaceDatabase(fixture);
    characterStore.init((await storage.loadStartupData())!.characters, storage);
    characterStore.select(0);
    flushSync();
    const snapshots = await characterStore.snapshot.loadAll();
    flushSync();
    await characterStore.flush();
    return snapshots;
  }

  function rows(table: string) {
    return sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  }

  it("atomically replaces [A,B,C] with [C,A,D], including positions and descendants", async () => {
    const [a, , c] = await seedThreeCharacters();
    const next = [
      c,
      a,
      { ...a, chaId: "char-d", name: "D", chats: [], chatPage: 99 },
    ];
    const commit = vi.spyOn(storage, "commit");
    await characterStore.snapshot.saveAll(next);
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0][0].replaceAll).toBeUndefined();
    expect(
      rows("characters")
        .sort((a, b) => Number(a.position) - Number(b.position))
        .map((row) => [row.id, row.position]),
    ).toEqual([
      ["char-3", 0],
      ["char-1", 1],
      ["char-d", 2],
    ]);
    expect(await storage.loadChat("chat-b")).toBeNull();
    for (const table of [
      "chats",
      "messages",
      "chat_branches",
      "chat_active_branches",
      "message_branch_links",
    ]) {
      expect(
        rows(table).some(
          (row) => row.chat_id === "chat-b" || row.id === "chat-b",
        ),
      ).toBe(false);
    }
    expect(characterStore.currentCharacter!.chaId).toBe("char-1");
    expect(get(selectedCharID)).toBe(1);
    expect(characterStore.characters[2].chatPage).toBe(0);
    expect((await restart()).map((character) => character.chaId)).toEqual([
      "char-3",
      "char-1",
      "char-d",
    ]);
  });

  it("persists order-only changes without changing any chat, message, or branch content", async () => {
    const [a, b, c] = await seedThreeCharacters();
    const before = [
      "chats",
      "messages",
      "chat_branches",
      "chat_active_branches",
      "message_branch_links",
    ].map(rows);
    await characterStore.snapshot.saveAll([b, a, c]);
    expect(
      [
        "chats",
        "messages",
        "chat_branches",
        "chat_active_branches",
        "message_branch_links",
      ].map(rows),
    ).toEqual(before);
    expect((await restart()).map((character) => character.chaId)).toEqual([
      "char-2",
      "char-1",
      "char-3",
    ]);
  });

  it("replaces [X,Y] with [Y,Z] and persists exact chat positions and deletion", async () => {
    const snapshot = (await characterStore.snapshot.load(0))!;
    snapshot.chats = [
      snapshot.chats[1],
      {
        name: "Z",
        note: "",
        localLore: [],
        message: [makeMessage("z-message", "user", "Z")],
      },
    ];
    snapshot.chatPage = 200;
    await characterStore.snapshot.save("char-1", snapshot);
    const restored = (await storage.loadCharacter("char-1"))!;
    expect(restored.chats.map((chat) => chat.name)).toEqual(["Second", "Z"]);
    expect(restored.chats[0].id).toBe("chat-2");
    expect(restored.chats[1].id).toBeTruthy();
    expect(restored.chatPage).toBe(1);
    expect(
      rows("chats")
        .map((row) => row.position)
        .sort(),
    ).toEqual([0, 1]);
    expect(await storage.loadChat("chat-1")).toBeNull();
    for (const table of [
      "messages",
      "chat_branches",
      "chat_active_branches",
      "message_branch_links",
    ])
      expect(rows(table).some((row) => row.chat_id === "chat-1")).toBe(false);
    expect((await restart())[0].chats.map((chat) => chat.id)).toEqual(
      restored.chats.map((chat) => chat.id),
    );
  });

  it("deletes all characters without touching settings, presets, modules, or plugin storage", async () => {
    await seedThreeCharacters();
    const unrelated = [
      "system_settings",
      "bot_presets",
      "module_records",
      "plugin_records",
      "plugin_scripts",
      "plugin_custom_storage",
    ];
    const before = unrelated.map(rows);
    expect(before.every((records) => records.length > 0)).toBe(true);
    await characterStore.snapshot.saveAll([]);
    for (const table of [
      "characters",
      "chats",
      "messages",
      "chat_branches",
      "chat_active_branches",
      "message_branch_links",
    ])
      expect(rows(table)).toEqual([]);
    expect(unrelated.map(rows)).toEqual(before);
    expect(characterStore.selectedId).toBe(-1);
    expect(await restart()).toEqual([]);
  });

  it("rewrites identical snapshots unconditionally while preserving content", async () => {
    const snapshots = await characterStore.snapshot.loadAll();
    flushSync();
    await characterStore.flush();
    const revision = storage.getRevision();
    const commit = vi.spyOn(storage, "commit");
    await characterStore.snapshot.saveAll(snapshots);
    flushSync();
    await characterStore.flush();
    await characterStore.snapshot.save(0, snapshots[0]);
    await characterStore.snapshot.chat.save(0, 0, snapshots[0].chats[0]);
    flushSync();
    await characterStore.flush();
    expect(commit).toHaveBeenCalled();
    expect(storage.getRevision()).toBeGreaterThan(revision);
    expect(await restart()).toEqual(snapshots);
  });

  it("rolls back earlier SQL changes when the final revision update fails, then retries successfully", async () => {
    const [a, , c] = await seedThreeCharacters();
    a.name = "Changed A";
    a.chats.reverse();
    a.chats[0].scriptstate = { $plugin: "replacement" };
    a.chats[0].message[0].data = "changed message";
    const next = [c, a, { ...a, chaId: "char-d", chats: [] }];
    const tables = [
      "characters",
      "character_extension_nodes",
      "chats",
      "chat_extension_nodes",
      "messages",
      "message_extension_nodes",
      "chat_branches",
      "chat_active_branches",
      "message_branch_links",
      "system_storage_meta",
      "system_revisions",
    ];
    const before = tables.map(rows);
    const resident = await characterStore.snapshot.loadAll();
    const revision = storage.getRevision();
    sql.exec(
      "CREATE TEMP TRIGGER fail_snapshot_revision BEFORE UPDATE OF revision ON system_storage_meta BEGIN SELECT RAISE(ABORT, 'snapshot transaction failure'); END",
    );
    await expect(characterStore.snapshot.saveAll(next)).rejects.toThrow(
      "snapshot transaction failure",
    );
    expect(tables.map(rows)).toEqual(before);
    expect(storage.getRevision()).toBe(revision);
    expect(await characterStore.snapshot.loadAll()).toEqual(resident);
    sql.exec("DROP TRIGGER fail_snapshot_revision");
    await characterStore.snapshot.saveAll(next);
    expect(storage.getRevision()).toBe(revision + 1);
    const restarted = await restart();
    expect(restarted.map((character) => character.chaId)).toEqual([
      "char-3",
      "char-1",
      "char-d",
    ]);
    expect(restarted[1].chats[0].scriptstate).toEqual({
      $plugin: "replacement",
    });
    expect(restarted[1].chats[0].message[0].data).toBe("changed message");
  });

  it("rejects a metadata-only shell because snapshot inputs must be complete", async () => {
    const shell = characterStore.getCharacterByIndex(0, { snapshot: true })!;
    expect(shell.detailsLoaded).toBe(false);
    expect(shell.chats).toEqual([]);
    await expect(
      characterStore.snapshot.saveAll([
        shell,
        characterStore.getCharacterByIndex(1, { snapshot: true })!,
      ]),
    ).rejects.toThrow("requires a complete snapshot");
    expect((await restart())[0].name).not.toBe("shell edit");
  });

  it("uses messageOffset for ID-less partial edits and adjusts the resident tail after additions", async () => {
    await loadResidentPage();
    const partial = characterStore.getCharacterByIndex(0, { snapshot: true })!
      .chats[0];
    delete partial.message[0].chatId;
    partial.message[0].data = "absolute 2";
    partial.message.push({ role: "user", data: "new tail" });
    await characterStore.snapshot.chat.save("char-1", "chat-1", partial);
    const restored = (await storage.loadChat("chat-1"))!;
    expect(restored.message).toHaveLength(15);
    expect(restored.message[2]).toMatchObject({
      chatId: "m2",
      data: "absolute 2",
    });
    expect(restored.message[0].data).toBe("message 0");
    const resident = characterStore.characters[0].chats[0];
    expect(resident.message).toHaveLength(12);
    expect(resident.messageOffset).toBe(3);
    expect(resident.messageTotal).toBe(15);
  });

  it("retains the start of a middle page and keeps unloaded histories empty after saving", async () => {
    await loadResidentPage();
    const resident = characterStore.characters[0].chats[0];
    resident.message = resident.message.slice(0, 4);
    resident.messageOffset = 2;
    const full = (await characterStore.snapshot.load(0))!;
    full.chats[0].message.push({ role: "user", data: "tail" });
    full.chats[1].message.push({ role: "user", data: "unloaded tail" });
    await characterStore.snapshot.save(0, full);
    expect(characterStore.characters[0].chats[0]).toMatchObject({
      messageOffset: 2,
      messageTotal: 15,
    });
    expect(characterStore.characters[0].chats[0].message).toHaveLength(4);
    expect(characterStore.characters[0].chats[1]).toMatchObject({
      message: [],
      messagesLoaded: false,
      messageTotal: 2,
    });
  });

  it("supports index and ID targets and keeps both IDs across a deferred write and reordering", async () => {
    const byIndex = (await characterStore.snapshot.chat.load(0, 0))!;
    expect(await characterStore.snapshot.chat.load("char-1", "chat-1")).toEqual(
      byIndex,
    );
    expect(await characterStore.snapshot.load("char-1")).toEqual(
      await characterStore.snapshot.load(0),
    );
    byIndex.scriptstate!.$plugin = "captured";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalFlush = messageStore.flush.bind(messageStore);
    const flush = vi
      .spyOn(messageStore, "flush")
      .mockImplementationOnce(async () => {
        await gate;
        await originalFlush();
      });
    const writing = characterStore.snapshot.chat.save(0, 0, byIndex);
    await vi.waitFor(() => expect(flush).toHaveBeenCalled());
    characterStore.characters.reverse();
    characterStore.getById("char-1")!.chats.reverse();
    flushSync();
    release();
    await writing;
    expect((await storage.loadChat("chat-1"))!.scriptstate!.$plugin).toBe(
      "captured",
    );
    expect((await storage.loadChat("chat-2"))!.scriptstate!.$plugin).toBe(
      "second-before",
    );
  });

  it("captures a character ID before a queued save even when indices change", async () => {
    const value = (await characterStore.snapshot.load(0))!;
    value.name = "captured character";
    const saving = characterStore.snapshot.save(0, value);
    characterStore.characters.reverse();
    flushSync();
    await saving;
    expect((await storage.loadCharacter("char-1"))!.name).toBe(
      "captured character",
    );
    expect((await storage.loadCharacter("char-2"))!.name).toBe("Beta");
  });

  it("clones all write inputs before yielding and returns independent nested read values", async () => {
    const snapshots = await characterStore.snapshot.loadAll();
    snapshots[0].chats[0].scriptstate!.$plugin = "call-time";
    snapshots[0].chats[0].message[0].data = "call-time";
    const writing = characterStore.snapshot.saveAll(snapshots);
    snapshots[0].chats[0].scriptstate!.$plugin = "caller edit";
    snapshots[0].chats[0].message[0].data = "caller edit";
    snapshots.reverse();
    await writing;
    const first = (await characterStore.snapshot.load(0))!;
    first.chats[0].scriptstate!.$plugin = "read edit";
    expect(
      (await characterStore.snapshot.chat.load(0, 0))!.scriptstate!.$plugin,
    ).toBe("call-time");
    expect((await storage.loadChat("chat-1"))!.message[0].data).toBe(
      "call-time",
    );
    const chat = (await characterStore.snapshot.chat.load(0, 0))!;
    const savingChat = characterStore.snapshot.chat.save(0, 0, chat);
    chat.message[0].data = "too late";
    await savingChat;
    expect((await storage.loadChat("chat-1"))!.message[0].data).toBe(
      "call-time",
    );
  });

  it.each(["character", "chat", "owner", "new-character", "new-chat"])(
    "rejects invalid %s input before snapshot persistence",
    async (invalid) => {
      const values = await characterStore.snapshot.loadAll();
      if (invalid === "character") values.push({ ...values[0] });
      if (invalid === "chat") values[0].chats.push({ ...values[0].chats[0] });
      if (invalid === "owner") values[1].chats.push(values[0].chats.shift()!);
      if (invalid === "new-character")
        values.push({ ...values[1], chaId: "new", detailsLoaded: false });
      if (invalid === "new-chat")
        values[0].chats.push({
          ...values[0].chats[0],
          id: "new-chat",
          messagesFullyLoaded: false,
        });
      flushSync();
      await characterStore.flush();
      const before = await storage.exportDatabaseSnapshot();
      const commit = vi.spyOn(storage, "commit");
      await expect(characterStore.snapshot.saveAll(values)).rejects.toThrow(
        /Duplicate|belongs to another|requires a complete/,
      );
      expect(commit).not.toHaveBeenCalled();
      expect(await storage.exportDatabaseSnapshot()).toEqual(before);
    },
  );

  it("renumbers later duplicate message IDs without mutating the caller", async () => {
    const value = (await characterStore.snapshot.chat.load(0, 0))!;
    value.message[1].chatId = value.message[0].chatId;
    await characterStore.snapshot.chat.save(0, 0, value);
    const restored = (await storage.loadChat("chat-1"))!;
    expect(restored.message[0].chatId).toBe("m0");
    expect(restored.message[1].chatId).not.toBe("m0");
    expect(
      new Set(restored.message.map((message) => message.chatId)).size,
    ).toBe(14);
    expect(value.message[1].chatId).toBe("m0");
  });

  it("rejects failed initial detail hydration instead of treating it as an empty chat list", async () => {
    expect(characterStore.characters[0].chats).toEqual([]);
    vi.spyOn(storage, "loadCharacterForSelection").mockResolvedValue(null);
    await expect(characterStore.snapshot.chat.load(0, 0)).rejects.toThrow(
      "Cannot load complete character",
    );
    await expect(
      characterStore.snapshot.chat.save(0, 0, {
        name: "ignored",
        note: "",
        localLore: [],
        message: [],
      }),
    ).rejects.toThrow("Cannot load complete character");
    expect((await storage.loadChat("chat-1"))!.message).toHaveLength(14);
  });

  it("binds destructured Store methods assigned directly to API properties", async () => {
    const { load, loadAll, save, saveAll, chat } = characterStore.snapshot;
    const api = {
      getCharacter: load,
      getDatabase: loadAll,
      setCharacter: save,
      setDatabase: saveAll,
      getChat: chat.load,
      setChat: chat.save,
    };
    const value = (await api.getCharacter("char-1"))!;
    value.name = "bound character";
    await api.setCharacter(0, value);
    const currentChat = (await api.getChat(0, "chat-1"))!;
    currentChat.scriptstate!.$plugin = "bound chat";
    await api.setChat("char-1", 0, currentChat);
    await api.setDatabase(await api.getDatabase());
    expect((await restart())[0]).toMatchObject({ name: "bound character" });
    expect((await storage.loadChat("chat-1"))!.scriptstate!.$plugin).toBe(
      "bound chat",
    );
  });

  it("persists two chat states and absolute 0/12 request tags through restart", async () => {
    await loadResidentPage();
    const value = (await characterStore.snapshot.load(0))!;
    value.chats[0].scriptstate!.$plugin = "first";
    value.chats[1].scriptstate!.$plugin = "second";
    value.chats[0].message[0].data += " request-0";
    value.chats[0].message[12].data += " request-12";
    await characterStore.snapshot.save(0, value);
    expect(characterStore.characters[0].chats[0].message).toHaveLength(12);
    for (const read of [
      (await characterStore.snapshot.load(0))!,
      (await restart())[0],
    ]) {
      expect(read.chats.map((chat) => chat.scriptstate!.$plugin)).toEqual([
        "first",
        "second",
      ]);
      expect(read.chats[0].message[0].data).toContain("request-0");
      expect(read.chats[0].message[12]).toMatchObject({
        role: "user",
        data: expect.stringContaining("request-12"),
      });
    }
  });
  it("loads and saves the second chat by index directly from a startup shell", async () => {
    expect(characterStore.characters[0].chats).toEqual([]);
    await characterStore.snapshot.chat.save(0, 1, {
      name: "Second",
      note: "",
      localLore: [],
      message: [],
      detailsLoaded: false,
      messagesLoaded: false,
      messagesFullyLoaded: false,
      scriptstate: { $plugin: "initial second" },
    });
    expect(
      (await characterStore.snapshot.chat.load(0, 1))!.message[0].data,
    ).toBe("three");
    expect(
      (await characterStore.snapshot.chat.load("char-1", "chat-2"))!
        .scriptstate!.$plugin,
    ).toBe("initial second");
    expect((await storage.loadChat("chat-1"))!.message).toHaveLength(14);
  });

  it("captures a chat read's ID before awaiting storage even when both lists reorder", async () => {
    await characterStore.ensureCharacterDetails("char-1");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalLoad = storage.loadChat.bind(storage);
    const read = vi
      .spyOn(storage, "loadChat")
      .mockImplementationOnce(async (id, options) => {
        await gate;
        return originalLoad(id, options);
      });
    const loading = characterStore.snapshot.chat.load(0, 0);
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    characterStore.characters.reverse();
    characterStore.getById("char-1")!.chats.reverse();
    release();
    expect((await loading)!.id).toBe("chat-1");
  });

  it("generates IDs on cloned new records and preserves them after restart", async () => {
    const value = (await characterStore.snapshot.load(0))!;
    value.chaId = "";
    value.chats = [
      {
        name: "generated",
        note: "",
        localLore: [],
        message: [{ role: "user", data: "new" }],
      },
    ];
    await characterStore.snapshot.saveAll([value]);
    expect(value.chaId).toBe("");
    expect(value.chats[0].id).toBeUndefined();
    expect(value.chats[0].message[0].chatId).toBeUndefined();
    const ids = [
      characterStore.characters[0].chaId,
      characterStore.characters[0].chats[0].id,
      characterStore.characters[0].chats[0].message[0].chatId,
    ];
    expect(ids.every(Boolean)).toBe(true);
    const restarted = (await restart())[0];
    expect([
      restarted.chaId,
      restarted.chats[0].id,
      restarted.chats[0].message[0].chatId,
    ]).toEqual(ids);
    expect(characterStore.selectedId).toBe(-1);
    expect(await storage.loadCharacter("char-1")).toBeNull();
  });

  it("treats empty complete histories and chat lists as explicit deletion", async () => {
    const value = (await characterStore.snapshot.load(0))!;
    value.chats[0].message = [];
    await characterStore.snapshot.save(0, value);
    expect((await storage.loadChat("chat-1"))!.message).toEqual([]);
    expect(rows("messages").filter((row) => row.chat_id === "chat-1")).toEqual(
      [],
    );
    value.chats = [];
    await characterStore.snapshot.save(0, value);
    expect((await restart())[0].chats).toEqual([]);
    expect(rows("chats")).toEqual([]);
    expect(rows("messages")).toEqual([]);
  });

  it("waits for an in-flight metadata commit before starting replacement", async () => {
    await characterStore.ensureCharacterDetails("char-1");
    flushSync();
    await characterStore.flush();
    characterStore.characters[0].name = "pending name";
    characterStore.markCharacterDirty("char-1");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalCommit = storage.commit.bind(storage);
    const commit = vi
      .spyOn(storage, "commit")
      .mockImplementationOnce(async (value) => {
        await gate;
        return originalCommit(value);
      });
    const pending = characterStore.flush();
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    let done = false;
    const replacement = characterStore.snapshot.saveAll([]).then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(done).toBe(false);
    expect(characterStore.characters).toHaveLength(2);
    expect(commit).toHaveBeenCalledOnce();
    release();
    await pending;
    await replacement;
    expect(await storage.loadCharacter("char-1")).toBeNull();
    expect(characterStore.characters).toEqual([]);
  });

  it("refuses replacement when preceding message persistence still fails", async () => {
    const value = (await characterStore.snapshot.chat.load(0, 0))!;
    const commit = vi
      .spyOn(storage, "commit")
      .mockRejectedValue(new Error("preceding message write failed"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await messageStore.updateMessage("chat-1", {
      ...value.message[0],
      data: "pending",
    });
    expect(messageStore.hasUnsavedWrites()).toBe(true);
    await expect(characterStore.snapshot.saveAll([])).rejects.toThrow(
      "preceding message write failed",
    );
    expect(characterStore.characters).toHaveLength(2);
    expect((await storage.loadChat("chat-1"))!.message[0].data).toBe(
      "message 0",
    );
    expect(
      commit.mock.calls.every(
        ([value]) => value.action !== "snapshot-characters",
      ),
    ).toBe(true);
    commit.mockRestore();
    await messageStore.flush();
    expect((await storage.loadChat("chat-1"))!.message[0].data).toBe("pending");
  });
  it("also refuses replacement when a failed message commit has been stashed for retry", async () => {
    const value = (await characterStore.snapshot.chat.load(0, 0))!;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const commit = vi
      .spyOn(storage, "commit")
      .mockRejectedValue(new Error("retained write failed"));
    await messageStore.updateMessage("chat-1", {
      ...value.message[0],
      data: "retained",
    });
    await expect(messageStore.flush()).rejects.toThrow("retained write failed");
    await messageStore.flush();
    expect(messageStore.hasPendingWrites()).toBe(false);
    expect(messageStore.hasUnsavedWrites()).toBe(true);
    await expect(characterStore.snapshot.saveAll([])).rejects.toThrow(
      "storage writes are pending",
    );
    expect(characterStore.characters).toHaveLength(2);
    expect(await storage.loadCharacter("char-1")).not.toBeNull();
    commit.mockRestore();
    await messageStore.flush();
    expect(messageStore.hasUnsavedWrites()).toBe(false);
    expect((await storage.loadChat("chat-1"))!.message[0].data).toBe(
      "retained",
    );
  });
  it.each(["character", "chat"])(
    "keeps the %s save target when lists reorder during history loading",
    async (kind) => {
      const value = (await characterStore.snapshot.load(0))!;
      value.name = "history-load character";
      value.chats[0].scriptstate!.$plugin = "history-load chat";
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const originalLoad = storage.loadChat.bind(storage);
      const read = vi
        .spyOn(storage, "loadChat")
        .mockImplementationOnce(async (id, options) => {
          await gate;
          return originalLoad(id, options);
        });
      const saving =
        kind === "character"
          ? characterStore.snapshot.save(0, value)
          : characterStore.snapshot.chat.save(0, 0, value.chats[0]);
      await vi.waitFor(() => expect(read).toHaveBeenCalled());
      characterStore.characters.reverse();
      characterStore.getById("char-1")!.chats.reverse();
      flushSync();
      release();
      await saving;
      expect(
        characterStore.characters.map((character) => character.chaId),
      ).toEqual(["char-2", "char-1"]);
      const saved = characterStore.getById("char-1")!;
      expect(new Set(saved.chats.map((chat) => chat.id)).size).toBe(2);
      expect(
        saved.chats.find((chat) => chat.id === "chat-1")!.scriptstate!.$plugin,
      ).toBe("history-load chat");
      expect((await storage.loadChat("chat-1"))!.scriptstate!.$plugin).toBe(
        "history-load chat",
      );
      expect((await storage.loadChat("chat-2"))!.scriptstate!.$plugin).toBe(
        "second-before",
      );
    },
  );
});
