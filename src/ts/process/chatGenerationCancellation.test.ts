import { describe, expect, it } from "vitest";
import {
  cancelLocalGeneration,
  registerLocalGeneration,
} from "./chatGenerationCancellation";

describe("cross-device generation cancellation", () => {
  it("aborts only the matching active lifecycle", () => {
    const first = new AbortController();
    const second = new AbortController();
    const unregisterFirst = registerLocalGeneration(
      "chat-a",
      first,
      () => "lifecycle-a",
    );
    const unregisterSecond = registerLocalGeneration(
      "chat-b",
      second,
      () => "lifecycle-b",
    );

    expect(cancelLocalGeneration("chat-a", "older-lifecycle")).toBe(false);
    expect(cancelLocalGeneration("chat-a", "lifecycle-a")).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);

    unregisterFirst();
    expect(cancelLocalGeneration("chat-a", "lifecycle-a")).toBe(false);
    unregisterSecond();
  });

  it("does not let an old cleanup remove a replacement generation", () => {
    const old = new AbortController();
    const current = new AbortController();
    const cleanupOld = registerLocalGeneration("chat-a", old, () => "old");
    const cleanupCurrent = registerLocalGeneration(
      "chat-a",
      current,
      () => "current",
    );

    cleanupOld();
    expect(cancelLocalGeneration("chat-a", "current")).toBe(true);
    expect(current.signal.aborted).toBe(true);
    cleanupCurrent();
  });
});
