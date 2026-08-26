import { describe, expect, it } from "vitest";
import { runWithPresetChainGenerationGate } from "./presetChainGenerationGate";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("preset chain generation gate", () => {
  it("serializes generations when the gate is enabled", async () => {
    const releaseFirst = deferred();
    const entered: string[] = [];
    const first = runWithPresetChainGenerationGate(true, async () => {
      entered.push("first");
      await releaseFirst.promise;
      return 1;
    });
    const second = runWithPresetChainGenerationGate(true, async () => {
      entered.push("second");
      return 2;
    });

    await Promise.resolve();
    expect(entered).toEqual(["first"]);
    releaseFirst.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(entered).toEqual(["first", "second"]);
  });

  it("does not serialize normal concurrent generations", async () => {
    const releaseFirst = deferred();
    const entered: string[] = [];
    const first = runWithPresetChainGenerationGate(false, async () => {
      entered.push("first");
      await releaseFirst.promise;
      return 1;
    });
    const second = runWithPresetChainGenerationGate(false, async () => {
      entered.push("second");
      return 2;
    });

    await Promise.resolve();
    expect(entered).toEqual(["first", "second"]);
    releaseFirst.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
  });
});