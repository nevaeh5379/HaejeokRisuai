import { describe, expect, it } from "vitest";
import {
  getActiveLocalBackupOperation,
  LocalBackupOperationBusyError,
  runExclusiveLocalBackupOperation,
} from "./localBackupOperationGate";

describe("local backup operation gate", () => {
  it("rejects overlapping save and restore operations", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = runExclusiveLocalBackupOperation("save", async () => {
      await blocked;
      return "saved";
    });
    expect(getActiveLocalBackupOperation()?.kind).toBe("save");
    await expect(
      runExclusiveLocalBackupOperation("restore", async () => "restored"),
    ).rejects.toBeInstanceOf(LocalBackupOperationBusyError);
    release();
    await expect(save).resolves.toBe("saved");
  });

  it("releases the gate after failures", async () => {
    await expect(
      runExclusiveLocalBackupOperation("restore", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(getActiveLocalBackupOperation()).toBeNull();
    await expect(
      runExclusiveLocalBackupOperation("partial-save", async () => "ok"),
    ).resolves.toBe("ok");
  });
});
