// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import sqliteSchemaSql from "@risuai/storage-sqlite/sqlite-schema.sql?raw";
import {
  makeHarness,
  makeWebStorage,
  makeTauriStorage,
  makeCapacitorStorage,
} from "../storage/sql/sqlite/sqliteTestHarness";
import {
  buildFullDatabase,
  makeMessage,
} from "../storage/sql/sqlite/sqliteTestFixtures";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { messageStore } from "../stores/domain/messageStore.svelte";
import { setSqlStorageForTesting } from "../storage/sql/sqlStorageFactory";
import {
  getPluginCharacter,
  getPluginCharacters,
  getPluginChat,
  replacePluginCharacters,
  setPluginCharacter,
  setPluginChat,
} from "./pluginCharacterApi";
import { getV2PluginAPIs } from "./plugins.svelte";
import { importChat } from "../characters";
import * as util from "../util";
import { selectedCharID } from "../stores.svelte";
import type { ISqlStorage } from "../storage/sql/ISqlStorage";
import type { character } from "../storage/database/schema";

describe.each([
  { name: "Web", make: makeWebStorage },
  { name: "Tauri", make: makeTauriStorage },
  { name: "Android", make: makeCapacitorStorage },
])("$name plugin character compatibility", ({ make }) => {
  let storage: ISqlStorage;
  let close: () => void;

  beforeEach(async () => {
    const harness = makeHarness<ISqlStorage>(make, sqliteSchemaSql);
    storage = harness.storage;
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
    const snapshot = await getPluginCharacter(0);
    expect(snapshot!.chats[0].message).toHaveLength(14);
    expect(snapshot!.chats[1].message[0].data).toBe("three");
    expect(snapshot!.chats[1].scriptstate).toEqual({
      $plugin: "second-before",
    });
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

  it("commits no message rows when only plugin state changes", async () => {
    const snapshot = await getPluginCharacter(0);
    snapshot!.chats[0].scriptstate!.$plugin = "after";
    await characterStore.flush();
    const commit = vi.spyOn(storage, "commit");
    await setPluginCharacter(0, snapshot!);
    const pluginCommit = commit.mock.calls
      .map(([commit]) => commit)
      .find((commit) => commit.action === "plugin-character");
    expect(pluginCommit!.messages).toEqual([]);
    expect(pluginCommit!.chats).toHaveLength(1);
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
});
