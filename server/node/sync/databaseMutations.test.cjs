"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDatabaseMutations } = require("../dist/databaseMutations.cjs");
const {
  deriveSqlCommitImpact,
  readSqlCommitImpactSink,
} = require("../../../packages/protocol/sqlCommit.cjs");

/**
 * Emulates the storage vendors: validateSyncPayload normally derives the
 * compact impact right after validation and reports it through the internal
 * options channel installed by databaseMutations.
 * 저장소 벤더를 흉내 냅니다. 실제 벤더는 검증 직후 압축 영향을 도출해
 * databaseMutations가 설치한 내부 옵션 채널로 보고합니다.
 */
function emulateVendorImpactCapture(options, normalizedCommit) {
  const sink = readSqlCommitImpactSink(options);
  if (sink) sink(deriveSqlCommitImpact(normalizedCommit));
}

/** Builds a minimal normalized commit for the vendor simulation. */
function normalizedCommit(overrides) {
  return {
    replaceAll: false,
    rootUpserts: [],
    rootDeletes: [],
    pluginStorageUpserts: [],
    pluginStorageDeletes: [],
    pluginStorageClear: false,
    characters: [],
    characterTouches: [],
    chats: [],
    messages: [],
    chatManifests: [],
    messageManifests: [],
    ...overrides,
  };
}

function createHarness(finalizeStorageSyncReplacement, captureImpact = true) {
  let revision = 40;
  const calls = [];
  const events = [];
  const storage = new Proxy(
    {},
    {
      get(_target, method) {
        return async (...args) => {
          calls.push({ method, args });
          // Like the real vendors, report the commit impact right after the
          // payload would have been validated, before any write succeeds.
          // 실제 벤더처럼, 쓰기가 성공하기 전 검증 시점에 커밋 영향을
          // 보고합니다.
          if (method === "sync" && captureImpact) {
            emulateVendorImpactCapture(
              args[1],
              normalizedCommit(
                args[0] && typeof args[0] === "object" ? args[0] : {},
              ),
            );
          }
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
    storage,
    mutations: createDatabaseMutations({
      getStorage: () => storage,
      finalizeStorageSyncReplacement:
        finalizeStorageSyncReplacement ??
        (async (options) => ({
          revision: 99,
          status: "completed",
          options,
        })),
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
  const { events, mutations, storage } = createHarness();

  await mutations.commit(
    { action: "message-edit", messages: [{ chatId: "chat-2" }] },
    "writer",
  );
  await mutations.restoreRevision(12, "writer");
  await mutations.restoreBackup({ replaceAll: true }, undefined, "writer");
  const finalizeResult = await mutations.storageSyncFinalize(
    { session: { id: "sync-1" } },
    "writer",
  );

  assert.equal(events[0].data.action, "message-edit");
  assert.deepEqual(events[0].data.chatIds, ["chat-2"]);
  assert.equal(events[0].data.revision, 41);
  assert.equal(events[1].data.replaceAll, true);
  assert.equal(events[2].data.replaceAll, true);
  assert.equal(events[3].data.action, "storage-sync-finalize");
  assert.equal(events[3].data.revision, 99);
  assert.equal(events[3].data.replaceAll, true);
  assert.equal(finalizeResult.options.sqlStorage, storage);
});

test("commit broadcasts the vendor-captured impact without leaking the channel", async () => {
  const { calls, events, mutations } = createHarness();

  await mutations.commit(
    {
      action: "message-edit",
      messages: [{ chatId: "chat-2" }],
      chats: [{ id: "chat-3", characterId: "char-3" }],
    },
    "writer",
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "database-change");
  assert.equal(events[0].data.action, "message-edit");
  // The impact is derived once inside the vendor and forwarded verbatim.
  // 영향은 벤더 안에서 한 번 도출되어 그대로 전달됩니다.
  assert.deepEqual(events[0].data.chatIds, ["chat-2", "chat-3"]);
  assert.deepEqual(events[0].data.characterIds, ["char-3"]);
  assert.equal(events[0].data.charactersChanged, false);
  assert.equal(events[0].data.revision, 41);
  assert.equal(events[0].data.sourceClientId, "writer");

  // The internal options channel must never surface on the stored sync call.
  const syncCall = calls.find((call) => call.method === "sync");
  assert.ok(syncCall);
  assert.deepEqual(Object.keys(syncCall.args[1]), []);
  assert.equal(JSON.stringify(syncCall.args[1]), "{}");
});

test("commit without vendor impact capture requests a full refresh", async () => {
  // Missing vendor metadata must fail safe: clients perform a full refresh
  // instead of silently missing the committed rows.
  // 벤더 메타데이터가 빠지면 클라이언트가 커밋 행을 조용히 놓치지 않도록
  // 전체 새로고침으로 안전하게 전환합니다.
  const { events, mutations } = createHarness(undefined, false);
  await mutations.commit({ action: "custom" }, "writer");
  assert.equal(events.length, 1);
  assert.equal(events[0].data.action, "sync");
  assert.equal(events[0].data.chatIds, undefined);
  assert.equal(events[0].data.replaceAll, true);
  assert.equal(events[0].data.revision, 41);
});

test("storage sync finalize does not broadcast before a failed transaction", async () => {
  const { events, mutations } = createHarness(async () => {
    throw new Error("transaction rolled back");
  });

  await assert.rejects(
    mutations.storageSyncFinalize({ session: { id: "sync-fail" } }, "writer"),
    /transaction rolled back/,
  );
  assert.equal(events.length, 0);
});

test("local backup finalize builds staging on the transaction client before commit", async () => {
  const order = [];
  const events = [];
  const client = { id: "transaction-client" };
  const transactionContext = { nextRevision: 42 };
  const sqlStaging = { validate: async () => ({ recordCount: 1 }) };
  const progress = () => {};
  const storage = {
    async getStorageSyncSummary() {
      return { revision: 41 };
    },
    async runStorageSyncFinalizeTransaction(expectedRevision, callback) {
      assert.equal(expectedRevision, 41);
      order.push("transaction");
      const value = await callback(client, transactionContext);
      order.push("commit");
      return { revision: 42, ...value };
    },
  };
  const mutations = createDatabaseMutations({
    getStorage: () => storage,
    finalizeStorageSyncReplacement: async () => {},
    applyStorageSyncSqlRecords: async (options) => {
      order.push("apply");
      assert.equal(options.client, client);
      assert.equal(options.sqlStaging, sqlStaging);
      assert.equal(options.onProgress, progress);
      return { recordCount: 1 };
    },
    getVendor: () => "postgres",
    realtimeEventHub: {
      broadcast(event, data) {
        order.push("broadcast");
        events.push({ event, data });
      },
    },
  });

  const result = await mutations.localBackupStreamFinalize(
    {
      prepared: {
        sourceRevision: 7,
        onProgress: progress,
        createSqlStaging(transactionClient) {
          order.push("create-staging");
          assert.equal(transactionClient, client);
          return sqlStaging;
        },
        async beforeCommit(context) {
          order.push("before-commit");
          assert.equal(context, transactionContext);
        },
        async afterCommit(commitResult) {
          order.push("after-commit");
          assert.equal(commitResult.revision, 42);
        },
      },
    },
    "writer",
  );

  assert.equal(result.revision, 42);
  assert.deepEqual(order, [
    "transaction",
    "create-staging",
    "apply",
    "before-commit",
    "commit",
    "after-commit",
    "broadcast",
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].data.replaceAll, true);
});
