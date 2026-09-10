"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDatabaseMutations } = require("./databaseMutations.cjs");

function createHarness() {
  let revision = 40;
  const calls = [];
  const events = [];
  const storage = new Proxy(
    {},
    {
      get(_target, method) {
        return async (...args) => {
          calls.push({ method, args });
          revision += 1;
          if (method === "activateChatBranch") return undefined;
          return { revision, method };
        };
      },
    },
  );
  const realtimeEventHub = {
    broadcast(event, data) {
      events.push({ event, data });
    },
  };
  return {
    calls,
    events,
    mutations: createDatabaseMutations({
      getStorage: () => storage,
      realtimeEventHub,
    }),
  };
}

test("database mutations always emit realtime changes", async () => {
  const { events, mutations } = createHarness();
  const source = " client-1 ";

  await mutations.createChatBranch(
    { chatId: "chat-1", id: "branch-1", reason: "reroll" },
    source,
  );
  await mutations.activateChatBranch("chat-1", "branch-1", source);
  await mutations.updateSetting("theme", "dark", source);
  await mutations.deleteSetting("language", source);
  await mutations.saveModule({ id: "module-1" }, source);
  await mutations.deleteModule("module-1", source);
  await mutations.saveMessage("chat-1", { id: "message-1" }, source);
  await mutations.deleteMessage("chat-1", "message-1", source);
  await mutations.togglePlugin(
    {
      baseRevision: 48,
      plugins: [{ name: "plugin-1", enabled: true }],
      pluginName: "plugin-1",
      enabled: true,
    },
    source,
  );
  await mutations.saveBotPreset({ id: "preset-1", name: "Preset" }, 0, source);

  assert.equal(events.length, 10);
  assert.deepEqual(
    events.map(({ data }) => data.action),
    [
      "chat-branch-create",
      "chat-branch-activate",
      "setting-update",
      "setting-delete",
      "module-save",
      "module-delete",
      "message-save",
      "message-delete",
      "plugin-toggle",
      "preset-save",
    ],
  );
  for (const { event, data } of events) {
    assert.equal(event, "database-change");
    assert.equal(data.sourceClientId, "client-1");
  }
  assert.deepEqual(events[0].data.chatIds, ["chat-1"]);
  assert.deepEqual(events[2].data.rootUpsertKeys, ["theme"]);
  assert.deepEqual(events[3].data.rootDeleteKeys, ["language"]);
  assert.equal(events[4].data.modulesChanged, true);
  assert.deepEqual(events[6].data.chatIds, ["chat-1"]);
  assert.equal(events[8].data.pluginName, "plugin-1");
  assert.equal(events[8].data.pluginEnabled, true);
  assert.equal(events[9].data.presetsChanged, true);
});

test("commit and restore expose revision-aware invalidation", async () => {
  const { events, mutations } = createHarness();

  await mutations.commit(
    { action: "message-edit", messages: [{ chatId: "chat-2" }] },
    "writer",
  );
  await mutations.restoreRevision(12, "writer");
  await mutations.restoreBackup({ replaceAll: true }, undefined, "writer");

  assert.equal(events[0].data.action, "message-edit");
  assert.deepEqual(events[0].data.chatIds, ["chat-2"]);
  assert.equal(events[0].data.revision, 41);
  assert.equal(events[1].data.replaceAll, true);
  assert.equal(events[2].data.replaceAll, true);
});
