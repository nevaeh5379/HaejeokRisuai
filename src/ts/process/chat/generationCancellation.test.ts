import { beforeEach, describe, expect, it, vi } from "vitest";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@logtape/logtape", () => ({ getLogger: () => ({ warn }) }));
import { LocalGenerationController } from "./generationCancellation";

beforeEach(() => warn.mockClear());

describe("cross-device generation cancellation", () => {
  it("aborts only the matching active lifecycle", () => {
    const generations = new LocalGenerationController();
    const first = new AbortController();
    const second = new AbortController();
    const registration = generations.register("chat-a", {
      controller: first,
      lifecycleId: () => "lifecycle-a",
    });
    generations.register("chat-b", {
      controller: second,
      lifecycleId: () => "lifecycle-b",
    });
    expect(registration).toBeUndefined();

    expect(generations.cancel("chat-a", "older-lifecycle")).toBe(false);
    expect(warn).toHaveBeenCalledWith("generation-cancel.failed {reason}", {
      reason: "lifecycle-mismatch",
      chatId: "chat-a",
      lifecycleId: "older-lifecycle",
      activeLifecycleId: "lifecycle-a",
    });
    expect(generations.cancel("chat-a", "lifecycle-a")).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);

    generations.unregister("chat-a", first);
    expect(generations.cancel("chat-a", "lifecycle-a")).toBe(false);
    expect(warn).toHaveBeenCalledWith("generation-cancel.failed {reason}", {
      reason: "no-active",
      chatId: "chat-a",
      lifecycleId: "lifecycle-a",
    });
    generations.unregister("chat-b", second);
  });

  it("does not let an old cleanup remove a replacement generation", () => {
    const generations = new LocalGenerationController();
    const old = new AbortController();
    const current = new AbortController();
    generations.register("chat-a", {
      controller: old,
      lifecycleId: () => "old",
    });
    generations.register("chat-a", {
      controller: current,
      lifecycleId: () => "current",
    });

    generations.unregister("chat-a", old);
    expect(warn).not.toHaveBeenCalled();
    expect(generations.cancel("chat-a", "current")).toBe(true);
    expect(current.signal.aborted).toBe(true);
    generations.unregister("chat-a", current);
  });
});
