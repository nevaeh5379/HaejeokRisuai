"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRealtimeEvent } = require("./realtimeEvents.cjs");

test("parseRealtimeEvent narrows database-change summaries", () => {
  const chatIds = ["chat-a"];
  const frame = parseRealtimeEvent("database-change", {
    eventId: 12,
    revision: 7,
    action: "sync",
    sourceClientId: "device-a",
    replaceAll: false,
    chatIds,
    rootUpsertKeys: ["theme"],
    rootChanged: true,
  });

  assert.deepEqual(frame, {
    event: "database-change",
    data: {
      revision: 7,
      action: "sync",
      sourceClientId: "device-a",
      chatIds: ["chat-a"],
      rootUpsertKeys: ["theme"],
      rootChanged: true,
      replaceAll: false,
    },
  });
  assert.equal(frame.data.chatIds, chatIds);
});

test("parseRealtimeEvent narrows every canonical realtime event", () => {
  assert.deepEqual(
    parseRealtimeEvent("model-job", {
      eventId: 3,
      phase: "created",
      job: {
        id: "job-1",
        chatId: "chat-1",
        generationId: null,
        status: "running",
        recoverable: true,
        targetOrigin: "https://example.com",
      },
      sourceClientId: "device-a",
    }),
    {
      event: "model-job",
      data: {
        phase: "created",
        job: {
          id: "job-1",
          chatId: "chat-1",
          generationId: null,
          status: "running",
          recoverable: true,
        },
        sourceClientId: "device-a",
      },
    },
  );

  assert.deepEqual(
    parseRealtimeEvent("generation-state", {
      chatId: "chat-1",
      lifecycleId: "life-1",
      state: "started",
      sourceClientId: null,
      updatedAt: 1234,
    }),
    {
      event: "generation-state",
      data: {
        chatId: "chat-1",
        lifecycleId: "life-1",
        state: "started",
        sourceClientId: null,
        updatedAt: 1234,
      },
    },
  );

  assert.deepEqual(
    parseRealtimeEvent("ready", {
      clientId: "device-a",
      connectedAt: 99,
      latestEventId: 5,
      activeGenerations: [
        {
          chatId: "chat-1",
          lifecycleId: "life-1",
          state: "started",
          sourceClientId: "device-b",
          updatedAt: 7,
        },
        "garbage",
      ],
    }),
    {
      event: "ready",
      data: {
        clientId: "device-a",
        connectedAt: 99,
        latestEventId: 5,
        activeGenerations: [
          {
            chatId: "chat-1",
            lifecycleId: "life-1",
            state: "started",
            sourceClientId: "device-b",
            updatedAt: 7,
          },
        ],
      },
    },
  );

  assert.deepEqual(
    parseRealtimeEvent("resync-required", {
      latestEventId: 9,
      oldestRetainedId: 2,
    }),
    {
      event: "resync-required",
      data: { latestEventId: 9, oldestRetainedId: 2 },
    },
  );
});

test("parseRealtimeEvent rejects malformed or unknown events", () => {
  assert.equal(parseRealtimeEvent("database-change", "not-an-object"), null);
  assert.equal(
    parseRealtimeEvent("database-change", { chatIds: ["chat-a", 42] }),
    null,
  );
  assert.equal(parseRealtimeEvent("model-job", { phase: "unknown" }), null);
  assert.equal(parseRealtimeEvent("generation-state", { chatId: "c" }), null);
  assert.equal(
    parseRealtimeEvent("generation-state", {
      chatId: "c",
      lifecycleId: "l",
      state: "exploded",
    }),
    null,
  );
  assert.equal(parseRealtimeEvent("ready", { connectedAt: 1 }), null);
  assert.equal(
    parseRealtimeEvent("resync-required", { latestEventId: -1 }),
    null,
  );
  assert.equal(parseRealtimeEvent("legacy-event", {}), null);
  assert.equal(parseRealtimeEvent("database-change", null), null);

  // Oversized strings are rejected so hostile streams cannot push unbounded
  // data into client state.
  assert.equal(
    parseRealtimeEvent("generation-state", {
      chatId: "c".repeat(257),
      lifecycleId: "l",
      state: "started",
    }),
    null,
  );
  assert.equal(
    parseRealtimeEvent("generation-state", {
      chatId: "chat-a",
      lifecycleId: "generation-a",
      state: "started",
      sourceClientId: "x".repeat(129),
    })?.data.sourceClientId,
    null,
  );
});
