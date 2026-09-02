import { afterEach, describe, expect, it } from "vitest";
import type { ISqlStorage } from "./ISqlStorage";
import {
  getSqlBranchStorage,
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
