"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  attachSqlCommitImpactSink,
  createSqlCommitValidator,
  deriveSqlCommitImpact,
  readSqlCommitImpactSink,
  SQL_COMMIT_IMPACT_CHANNEL,
} = require("./sqlCommit.cjs");

/** Builds a minimal normalized commit for impact-derivation assertions. */
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

test("deriveSqlCommitImpact extracts affected domains and entity ids", () => {
  const impact = deriveSqlCommitImpact(
    normalizedCommit({
      rootUpserts: [
        { key: "temperature", value: 80 },
        { key: "temperature", value: 90 },
      ],
      rootDeletes: ["oldSetting", "oldSetting"],
      characters: [{ id: "char-a", position: 0, data: {} }],
      characterTouches: [{ id: "char-touched", lastInteraction: 1 }],
      characterDeletes: ["char-deleted"],
      characterIds: ["char-a"],
      chats: [{ id: "chat-a", characterId: "char-a", position: 0, data: {} }],
      chatDeletes: ["chat-deleted"],
      messages: [
        { id: "msg-a", chatId: "chat-a", position: 0, data: {} },
        { id: "msg-b", chatId: "chat-b", position: 1, data: {} },
      ],
      messageManifests: [{ chatId: "chat-b", ids: ["msg-b"] }],
      pluginStorageUpserts: [
        { key: "plugin-a", value: { n: 1 } },
        { key: "plugin-a", value: { n: 2 } },
      ],
      pluginStorageDeletes: ["plugin-b", "plugin-b"],
      pluginStorageClear: true,
      presets: {
        upserts: [{ id: "preset-a", data: {} }],
        deletes: ["preset-b"],
        order: ["preset-a"],
        activeId: "preset-a",
      },
      modules: {
        upserts: [{ id: "module-a", data: {} }],
        deletes: ["module-b"],
      },
    }),
  );

  assert.deepEqual([...impact.chatIds].sort(), [
    "chat-a",
    "chat-b",
    "chat-deleted",
  ]);
  assert.equal(impact.action, "sync");
  assert.deepEqual(impact.characterIds, ["char-a", "char-deleted"]);
  assert.equal(impact.charactersChanged, true);
  assert.deepEqual(impact.rootUpsertKeys, ["temperature"]);
  assert.deepEqual(impact.rootDeleteKeys, ["oldSetting"]);
  assert.equal(impact.rootChanged, true);
  assert.deepEqual(impact.pluginStorageUpsertKeys, ["plugin-a"]);
  assert.deepEqual(impact.pluginStorageDeleteKeys, ["plugin-b"]);
  assert.equal(impact.pluginStorageCleared, true);
  assert.equal(impact.presetsChanged, true);
  assert.equal(impact.modulesChanged, true);
});

test("character touches do not request a full character-index refresh", () => {
  const impact = deriveSqlCommitImpact(
    normalizedCommit({
      characterTouches: [{ id: "char-a", lastInteraction: 123 }],
    }),
  );

  assert.deepEqual(impact.characterIds, []);
  assert.equal(impact.charactersChanged, false);
  assert.deepEqual(impact.chatIds, []);
  assert.equal(impact.rootChanged, false);
  assert.equal(impact.presetsChanged, false);
  assert.equal(impact.modulesChanged, false);
});

test("impact uses the validator-normalized action", () => {
  const impact = deriveSqlCommitImpact(
    normalizedCommit({ action: "message-edit" }),
  );

  assert.equal(impact.action, "message-edit");
});

test("impact does not revive an action rejected by validation", () => {
  const validate = createSqlCommitValidator({ PayloadError: Error });
  const commit = validate({
    baseRevision: 0,
    action: "x".repeat(65),
    root: { upserts: [], deletes: [] },
    characters: [],
    chats: [],
    chatManifests: [],
    messages: [],
    messageManifests: [],
  });

  assert.equal(commit.action, undefined);
  assert.equal(deriveSqlCommitImpact(commit).action, "sync");
});

test("replace-all marks every realtime domain changed without listing ids", () => {
  const impact = deriveSqlCommitImpact(normalizedCommit({ replaceAll: true }));

  assert.equal(impact.replaceAll, true);
  assert.equal(impact.rootChanged, true);
  assert.equal(impact.charactersChanged, true);
  assert.equal(impact.presetsChanged, true);
  assert.equal(impact.modulesChanged, true);
  assert.deepEqual(impact.chatIds, []);
  assert.deepEqual(impact.rootUpsertKeys, []);
});

test("internal impact channel stays non-enumerable and never leaks", () => {
  const impacts = [];
  const options = {};
  const sink = (impact) => impacts.push(impact);
  attachSqlCommitImpactSink(options, sink);

  // Non-enumerable: plain spreads and JSON round-trips cannot leak it.
  assert.equal(Object.keys(options).includes(SQL_COMMIT_IMPACT_CHANNEL), false);
  assert.deepEqual(Object.keys(options), []);
  assert.equal(
    JSON.stringify(options),
    "{}",
    "impact channel must not serialize",
  );

  const reported = deriveSqlCommitImpact(
    normalizedCommit({
      messages: [{ id: "m", chatId: "chat-1", position: 0, data: {} }],
    }),
  );
  const read = readSqlCommitImpactSink(options);
  assert.equal(read, sink);
  read(reported);
  assert.deepEqual(impacts, [reported]);

  // Plain objects, option wrappers, and function-form options are all read.
  function legacyOptions() {}
  attachSqlCommitImpactSink(legacyOptions, sink);
  assert.equal(readSqlCommitImpactSink(legacyOptions), sink);
  assert.equal(readSqlCommitImpactSink(undefined), null);
  assert.equal(readSqlCommitImpactSink(null), null);
  assert.equal(readSqlCommitImpactSink("nope"), null);
  assert.equal(readSqlCommitImpactSink({}), null);
  assert.equal(
    readSqlCommitImpactSink({ [SQL_COMMIT_IMPACT_CHANNEL]: "not-a-function" }),
    null,
  );
});
