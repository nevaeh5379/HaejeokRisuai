import { describe, expect, it } from "vitest";
import { get } from "svelte/store";
import {
  modelRequestNotices,
  notifyModelRequest,
  trackModelResponse,
} from "./modelRequestNotices";

const latest = () => get(modelRequestNotices).at(-1)!;

describe("model request notices", () => {
  it("records the duration of a non-streaming response", async () => {
    const finish = notifyModelRequest("model-a", "model");
    expect(latest().endedAt).toBeUndefined();
    await trackModelResponse(
      Promise.resolve({ type: "success", result: "ok" }),
      finish,
    );
    expect(latest().endedAt).toBeGreaterThanOrEqual(latest().startedAt);
    expect(latest().failed).toBe(false);
  });

  it("marks failed responses", async () => {
    const finish = notifyModelRequest("model-b", "submodel");
    await trackModelResponse(
      Promise.resolve({ type: "fail", result: "no" }),
      finish,
    );
    expect(latest().failed).toBe(true);
  });

  it("ends a streaming request only after the stream closes", async () => {
    const finish = notifyModelRequest("model-c", "model");
    const res = await trackModelResponse(
      Promise.resolve({
        type: "streaming",
        result: new ReadableStream<string>({
          start(c) {
            c.enqueue("a");
            c.close();
          },
        }),
      }),
      finish,
    );
    expect(latest().endedAt).toBeUndefined();
    const reader = (res.result as ReadableStream<string>).getReader();
    expect((await reader.read()).value).toBe("a");
    expect((await reader.read()).done).toBe(true);
    expect(latest().endedAt).toBeDefined();
  });
});
