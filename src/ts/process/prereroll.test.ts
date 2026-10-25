import { beforeEach, describe, expect, test } from "vitest";
import { addRerolls, clearRerolls, Prereroll, PreUnreroll } from "./prereroll";

describe("prereroll cache", () => {
  beforeEach(() => {
    clearRerolls();
  });

  test("stores rerolls and navigates forward and backward", () => {
    addRerolls("gen-1", ["candidate 0", "candidate 1", "candidate 2"]);

    expect(Prereroll("gen-1")).toBe("candidate 1");
    expect(Prereroll("gen-1")).toBe("candidate 2");
    expect(Prereroll("gen-1")).toBeNull();

    expect(PreUnreroll("gen-1")).toBe("candidate 2");
    expect(PreUnreroll("gen-1")).toBe("candidate 1");
    expect(PreUnreroll("gen-1")).toBe("candidate 0");
    expect(PreUnreroll("gen-1")).toBeNull();
  });

  test("evicts oldest entries when exceeding max capacity (64)", () => {
    for (let i = 0; i < 70; i++) {
      addRerolls(`gen-${i}`, [`val-${i}`]);
    }

    // gen-0 through gen-5 should have been evicted
    expect(Prereroll("gen-0")).toBeNull();
    expect(Prereroll("gen-5")).toBeNull();

    // gen-6 through gen-69 should be present
    expect(PreUnreroll("gen-69")).toBeNull(); // index 0 - 1 < 0
    expect(Prereroll("gen-69")).toBeNull(); // length is 1, index + 1 is 1 -> null
  });
});
