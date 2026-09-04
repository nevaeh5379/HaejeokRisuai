import { beforeEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import {
  captureModuleRequest,
  capturedModuleRequests,
  clearModuleRequestCapture,
  setModuleRequestCapture,
} from "./moduleRequestCapture";

describe("request capture memory limits", () => {
  beforeEach(() => {
    clearModuleRequestCapture();
    setModuleRequestCapture(false);
  });
  const request = () => ({
    activeModuleIds: ["a"],
    messages: [{ role: "user", content: "hello" }],
    decision: { status: "unmatched" as const, modules: [] },
  });
  it("retains no prompts until explicitly enabled, and can clear retained prompts", () => {
    captureModuleRequest(request());
    expect(get(capturedModuleRequests)).toEqual([]);
    setModuleRequestCapture(true);
    captureModuleRequest(request());
    setModuleRequestCapture(false);
    captureModuleRequest(request());
    expect(get(capturedModuleRequests)).toHaveLength(1);
    clearModuleRequestCapture();
    expect(get(capturedModuleRequests)).toEqual([]);
  });
  it("bounds request count and text size without holding mutable request references", () => {
    setModuleRequestCapture(true);
    const value = request();
    for (let i = 0; i < 8; i++) captureModuleRequest(value);
    value.messages[0].content = "changed";
    expect(get(capturedModuleRequests)).toHaveLength(5);
    expect(get(capturedModuleRequests)[0].messages[0].content).toBe("hello");
    captureModuleRequest({
      ...request(),
      messages: [{ role: "user", content: "x".repeat(50000) }],
    });
    expect(get(capturedModuleRequests)[0].truncated).toBe(true);
    expect(get(capturedModuleRequests)[0].messages[0].content).toHaveLength(
      24000,
    );
  });
});
