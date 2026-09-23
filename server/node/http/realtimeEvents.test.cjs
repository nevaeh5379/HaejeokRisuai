"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const { createRealtimeEventHub } = require("../dist/http/realtimeEvents.cjs");
const {
  parseRealtimeEvent,
} = require("../../../packages/protocol/realtimeEvents.cjs");

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

test("backup progress is transient and does not consume replay history", () => {
  const hub = createRealtimeEventHub({ heartbeatMs: 60_000 });
  const req = new EventEmitter();
  req.headers = {};
  const res = new FakeResponse();
  hub.connect(req, res);

  hub.broadcastTransient("local-backup-import-progress", {
    jobId: "backup-1",
    status: "restoring",
    progress: { stage: "database", current: 2, total: 3 },
  });

  const output = res.chunks.join("");
  assert.match(output, /event: local-backup-import-progress/);
  assert.match(output, /"jobId":"backup-1"/);
  assert.equal(hub.latestEventId(), 0);
  req.emit("close");
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

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.frames = [];
    this.pings = 0;
  }
  send(frame) {
    this.frames.push(JSON.parse(String(frame)));
  }
  ping() {
    this.pings += 1;
  }
}

test("realtime hub replays and broadcasts the same protocol over WebSocket", () => {
  const hub = createRealtimeEventHub({ heartbeatMs: 60_000, historyLimit: 4 });
  hub.broadcast("database-change", { revision: 1, chatIds: ["chat-a"] });
  const ws = new FakeWebSocket();

  hub.connectWebSocket(ws, { clientId: "device-b", lastEventId: 0 });
  assert.equal(ws.frames[0].id, 1);
  assert.equal(ws.frames[0].event, "database-change");
  assert.equal(ws.frames[1].event, "ready");
  assert.equal(ws.frames[1].data.clientId, "device-b");

  hub.broadcast("database-change", { revision: 2, chatIds: ["chat-a"] });
  const latest = ws.frames.at(-1);
  assert.equal(latest.id, 2);
  assert.equal(latest.event, "database-change");
  assert.equal(latest.data.revision, 2);
  assert.equal(hub.clientCount(), 1);

  ws.emit("close");
  assert.equal(hub.clientCount(), 0);
});

test("fresh WebSocket connection with a null cursor does not replay history", () => {
  const hub = createRealtimeEventHub({ heartbeatMs: 60_000, historyLimit: 4 });
  hub.broadcast("generation-state", {
    chatId: "chat-old",
    lifecycleId: "lifecycle-old",
    state: "finished",
  });
  hub.broadcast("model-job", {
    phase: "terminal",
    job: { id: "job-old", chatId: "chat-old", status: "done" },
  });
  const ws = new FakeWebSocket();

  hub.connectWebSocket(ws, { clientId: "device-fresh", lastEventId: null });

  assert.equal(ws.frames.length, 1);
  assert.equal(ws.frames[0].event, "ready");
  assert.equal(ws.frames[0].data.latestEventId, 2);
  ws.emit("close");
});

test("typed broadcast payloads round-trip through the shared event parser", () => {
  const hub = createRealtimeEventHub({ heartbeatMs: 60_000, historyLimit: 4 });
  const req = new EventEmitter();
  req.headers = { "x-risu-client-id": "device-a" };
  const res = new FakeResponse();
  hub.connect(req, res);

  // Producers are keyed by the shared realtime event map; every broadcast
  // payload must stay parseable by the client-side narrowing contract.
  // 생산자는 공유 실시간 이벤트 맵으로 형식화되며, 모든 전파 페이로드는
  // 클라이언트 좁히기 계약으로 다시 해석될 수 있어야 합니다.
  hub.broadcast("database-change", {
    revision: 7,
    action: "sync",
    chatIds: ["chat-a"],
    charactersChanged: false,
  });
  const output = res.chunks.join("");
  const match = /event: database-change\ndata: (.+)\n\n/.exec(
    output.slice(output.indexOf("event: database-change")),
  );
  assert.ok(match);
  const frame = parseRealtimeEvent("database-change", JSON.parse(match[1]));
  // The hub stamps its own eventId onto the envelope; the parsed client-side
  // summary carries only the compact payload.
  // 파싱된 클라이언트 요약은 허브의 eventId를 제외한 압축 페이로드만
  // 담습니다.
  assert.deepEqual(frame, {
    event: "database-change",
    data: {
      revision: 7,
      action: "sync",
      chatIds: ["chat-a"],
      charactersChanged: false,
    },
  });
  req.emit("close");
});
