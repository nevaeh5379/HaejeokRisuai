import { describe, expect, it, vi } from "vitest";
import type { ISqlStorage } from "./ISqlStorage";
import { createEmptySqlCommit } from "./sqlCommit";
import { commitSqlChanges } from "./sqlCommitCoordinator";
import { saving } from "./saveActivity.svelte";

function storageWithCommit(
  commit: ISqlStorage["commit"],
  getRevision: ISqlStorage["getRevision"],
): ISqlStorage {
  return { commit, getRevision } as ISqlStorage;
}

describe("commitSqlChanges", () => {
  it("serializes concurrent domain commits and rebases the second write", async () => {
    let revision = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const bases: number[] = [];
    const commit = vi.fn(async (value) => {
      bases.push(value.baseRevision);
      if (bases.length === 1) await firstGate;
      revision++;
      return { revision };
    });
    const storage = storageWithCommit(commit, () => revision);

    const first = commitSqlChanges(storage, createEmptySqlCommit(0, "first"));
    const second = commitSqlChanges(storage, createEmptySqlCommit(0, "second"));
    expect(saving.state).toBe(true);
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { revision: 1 },
      { revision: 2 },
    ]);
    expect(bases).toEqual([0, 1]);
    expect(saving.state).toBe(false);
  });

  it("retries once at the server supplied revision after a conflict", async () => {
    const conflict = Object.assign(new Error("conflict"), {
      currentRevision: 7,
    });
    const commit = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ revision: 8 });
    const storage = storageWithCommit(commit, () => 3);

    await expect(
      commitSqlChanges(storage, createEmptySqlCommit(0)),
    ).resolves.toEqual({ revision: 8 });
    expect(commit.mock.calls.map(([value]) => value.baseRevision)).toEqual([
      3, 7,
    ]);
  });

  it("does not let a failed write poison later commits", async () => {
    let revision = 0;
    const commit = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockImplementation(async () => ({ revision: ++revision }));
    const storage = storageWithCommit(commit, () => revision);

    await expect(
      commitSqlChanges(storage, createEmptySqlCommit(0)),
    ).rejects.toThrow("disk full");
    expect(saving.state).toBe(false);
    await expect(
      commitSqlChanges(storage, createEmptySqlCommit(0)),
    ).resolves.toEqual({ revision: 1 });
    expect(saving.state).toBe(false);
  });

  it("keeps the saving indicator active until queued writes finish", async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const commit = vi
      .fn()
      .mockImplementationOnce(async () => {
        await firstGate;
        return { revision: 1 };
      })
      .mockImplementationOnce(async () => {
        await secondGate;
        return { revision: 2 };
      });
    const storage = storageWithCommit(commit, () => commit.mock.calls.length);

    const first = commitSqlChanges(storage, createEmptySqlCommit(0, "first"));
    const second = commitSqlChanges(storage, createEmptySqlCommit(0, "second"));
    expect(saving.state).toBe(true);

    releaseFirst();
    await first;
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
    expect(saving.state).toBe(true);

    releaseSecond();
    await second;
    expect(saving.state).toBe(false);
  });
});
