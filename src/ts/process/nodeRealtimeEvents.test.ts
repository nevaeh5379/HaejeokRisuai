import { describe, expect, it } from "vitest";
import { mergeDatabaseChanges } from "./nodeRealtimeChangeQueue";
import { parseRealtimeEvent } from "../../../packages/protocol/realtimeEvents.cjs";

/**
 * The SSE/WebSocket boundary is untrusted, so the frontend must narrow
 * JSON.parse results through the shared protocol parser before enqueueing.
 * SSE/WebSocket 경계는 신뢰할 수 없으므로, 프론트엔드는 JSON.parse 결과를
 * 큐에 넣기 전 공유 프로토콜 파서로 좁혀야 합니다.
 */
describe("realtime event boundary parsing", () => {
  it("parses a database-change broadcast into a queueable change", () => {
    const frame = parseRealtimeEvent("database-change", {
      eventId: 12,
      revision: 7,
      action: "sync",
      sourceClientId: "server",
      chatIds: ["chat-a"],
      charactersChanged: false,
      pluginsChanged: true,
    });

    if (frame?.event !== "database-change") throw new Error("unreachable");
    expect(frame.event).toBe("database-change");

    const merged = mergeDatabaseChanges(null, frame.data);
    expect(merged.chatIds).toEqual(["chat-a"]);
    expect(merged.charactersChanged).toBe(false);
    expect(merged.pluginsChanged).toBe(true);
  });

  it("drops malformed or unknown realtime events instead of casting", () => {
    expect(parseRealtimeEvent("database-change", "garbage")).toBeNull();
    expect(parseRealtimeEvent("model-job", { phase: "nonsense" })).toBeNull();
    expect(parseRealtimeEvent("unknown-event", {})).toBeNull();
  });

  it("parses ready and generation-state summaries with bounded strings", () => {
    const ready = parseRealtimeEvent("ready", {
      clientId: "device-a",
      latestEventId: 4,
      activeGenerations: [
        {
          chatId: "chat-1",
          lifecycleId: "life-1",
          state: "started",
          sourceClientId: "device-b",
          updatedAt: 10,
        },
      ],
    });
    if (ready?.event !== "ready") throw new Error("unreachable");
    expect(ready.data.activeGenerations).toHaveLength(1);
    expect(ready.data.latestEventId).toBe(4);

    const state = parseRealtimeEvent("generation-state", {
      chatId: "chat-1",
      lifecycleId: "life-1",
      state: "finished",
      sourceClientId: "device-b",
    });
    if (state?.event !== "generation-state") throw new Error("unreachable");
    expect(state.data.state).toBe("finished");
  });
});
