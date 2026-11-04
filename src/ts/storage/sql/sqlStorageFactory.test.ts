import { createEmptySqlCommit } from "./sqlCommit";
import { createSqlMessageMutations } from "./sqlCommitCoordinator";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ISqlStorage } from "@risuai/storage-core/sqlStorage";
import {
  getSqlBranchStorage,
  getSqlStorage,
  setSqlStorageForTesting,
} from "./sqlStorageFactory";

describe("getSqlBranchStorage", () => {
  afterEach(() => {
    setSqlStorageForTesting(null);
  });

  it("fails fast instead of falling back when branch APIs are unavailable", async () => {
    setSqlStorageForTesting({} as ISqlStorage);

    await expect(getSqlBranchStorage()).rejects.toThrow(
      /Persistent chat branch storage is required; missing API:/,
    );
  });
});

describe("message mutation serialization", () => {
  afterEach(() => setSqlStorageForTesting(null));

  it("shares the wrapped commit queue with other domain writes", async () => {
    let revision = 0;
    const bases: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = {
      getRevision: () => revision,
      commit: vi.fn(async (commit) => {
        bases.push(commit.baseRevision);
        if (bases.length === 1) await gate;
        expect(commit.baseRevision).toBe(revision);
        return { revision: ++revision };
      }),
    } as unknown as ISqlStorage;
    inner.message = createSqlMessageMutations(inner) as ISqlStorage["message"];
    setSqlStorageForTesting(inner);
    const storage = await getSqlStorage();
    const first = storage.commit(createEmptySqlCommit(0));
    const second = storage.message.save("chat-1", {
      chatId: "message-1",
      role: "user",
      data: "hello",
      position: 0,
    });
    release();
    await Promise.all([first, second]);
    expect(bases).toEqual([0, 1]);
  });
});
