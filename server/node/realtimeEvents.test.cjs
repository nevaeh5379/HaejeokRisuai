"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const {
  createRealtimeEventHub,
  describeSqlCommitChange,
} = require("./realtimeEvents.cjs");

test("describeSqlCommitChange extracts affected chat and character ids", () => {
  const change = describeSqlCommitChange({
    action: "message",
    root: {
      upserts: [
        { key: "temperature", value: 80 },
        { key: "temperature", value: 90 },
      ],
      deletes: ["oldSetting", "oldSetting"],
    },
    characters: [{ id: "char-a" }],
    characterDeletes: ["char-deleted"],
    chats: [{ id: "chat-a", characterId: "char-a" }],
    chatDeletes: ["chat-deleted"],
    messages: [
      { id: "msg-a", chatId: "chat-a" },
      { id: "msg-b", chatId: "chat-b" },
    ],
    messageManifests: [{ chatId: "chat-b", ids: ["msg-b"] }],
    pluginStorage: {
      upserts: [
        { key: "plugin-a", value: { n: 1 } },
        { key: "plugin-a", value: { n: 2 } },
      ],
      deletes: ["plugin-b", "plugin-b"],
      clear: true,
    },
  });

  assert.deepEqual(change.chatIds.sort(), ["chat-a", "chat-b", "chat-deleted"]);
  assert.deepEqual(change.characterIds, ["char-a", "char-deleted"]);
  assert.deepEqual(change.rootUpsertKeys, ["temperature"]);
  assert.deepEqual(change.rootDeleteKeys, ["oldSetting"]);
  assert.equal(change.rootChanged, true);
  assert.deepEqual(change.pluginStorageUpsertKeys, ["plugin-a"]);
  assert.deepEqual(change.pluginStorageDeleteKeys, ["plugin-b"]);
  assert.equal(change.pluginStorageCleared, true);
});

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.chunks = [];
    this.destroyed = false;
    this.writableEnded = false;
  }
  status() {
    return this;
  }
  set() {
    return this;
  }
  flushHeaders() {}
  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }
}

test("realtime hub streams ready and broadcast events to connected clients", () => {
  const hub = createRealtimeEventHub({ heartbeatMs: 60_000 });
  const req = new EventEmitter();
  req.headers = { "x-risu-client-id": "device-a" };
  const res = new FakeResponse();

  hub.connect(req, res);
  hub.broadcast("database-change", { revision: 7, chatIds: ["chat-a"] });
  const output = res.chunks.join("");
  assert.match(output, /event: ready/);
  assert.match(output, /event: database-change/);
  assert.match(output, /"revision":7/);
  assert.match(output, /"chatIds":\["chat-a"\]/);
  assert.equal(hub.clientCount(), 1);
  req.emit("close");
  assert.equal(hub.clientCount(), 0);
});

test("broadcasts share one event id across clients and reconnects replay missed events", () => {
  const hub = createRealtimeEventHub({ heartbeatMs: 60_000, historyLimit: 4 });
  const reqA = new EventEmitter();
  reqA.headers = { "x-risu-client-id": "device-a" };
  const reqB = new EventEmitter();
  reqB.headers = { "x-risu-client-id": "device-b" };
  const resA = new FakeResponse();
  const resB = new FakeResponse();

  hub.connect(reqA, resA);
  hub.connect(reqB, resB);
  hub.broadcast("database-change", { revision: 1 });
  assert.match(resA.chunks.join(""), /id: 1\nevent: database-change/);
  assert.match(resB.chunks.join(""), /id: 1\nevent: database-change/);
  assert.equal(hub.latestEventId(), 1);

  reqB.emit("close");
  hub.broadcast("database-change", { revision: 2 });
  hub.broadcast("model-job", { phase: "created" });
  const replayReq = new EventEmitter();
  replayReq.headers = {
    "x-risu-client-id": "device-b",
    "last-event-id": "1",
  };
  const replayRes = new FakeResponse();
  hub.connect(replayReq, replayRes);
  const replayOutput = replayRes.chunks.join("");
  assert.match(replayOutput, /id: 2\nevent: database-change/);
  assert.match(replayOutput, /id: 3\nevent: model-job/);
  assert.doesNotMatch(replayOutput, /resync-required/);
  replayReq.emit("close");
  reqA.emit("close");
});

test("realtime hub requests resync when the replay window was lost", () => {
  const hub = createRealtimeEventHub({ heartbeatMs: 60_000, historyLimit: 2 });
  hub.broadcast("database-change", { revision: 1 });
  hub.broadcast("database-change", { revision: 2 });
  hub.broadcast("database-change", { revision: 3 });
  const req = new EventEmitter();
  req.headers = {
    "x-risu-client-id": "device-late",
    "last-event-id": "0",
  };
  const res = new FakeResponse();
  hub.connect(req, res);
  const output = res.chunks.join("");
  assert.match(output, /event: resync-required/);
  assert.match(output, /"latestEventId":3/);
  assert.match(output, /"oldestRetainedId":2/);
  req.emit("close");
});

test("realtime hub snapshots active generation lifecycle state", () => {
  const hub = createRealtimeEventHub({ heartbeatMs: 60_000 });
  const started = hub.updateGenerationState(
    {
      chatId: "chat-a",
      lifecycleId: "life-a",
      state: "started",
    },
    "device-a",
  );
  assert.equal(started.chatId, "chat-a");
  assert.equal(hub.listActiveGenerations().length, 1);

  const req = new EventEmitter();
  req.headers = { "x-risu-client-id": "device-b" };
  const res = new FakeResponse();
  hub.connect(req, res);
  const output = res.chunks.join("");
  assert.match(output, /event: ready/);
  assert.match(output, /"activeGenerations":\[/);
  assert.match(output, /"lifecycleId":"life-a"/);

  hub.updateGenerationState(
    {
      chatId: "chat-a",
      lifecycleId: "life-a",
      state: "finished",
    },
    "device-a",
  );
  assert.deepEqual(hub.listActiveGenerations(), []);
  req.emit("close");
});
