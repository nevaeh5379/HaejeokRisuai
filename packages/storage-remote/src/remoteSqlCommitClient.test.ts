import { describe, expect, it, vi } from "vitest";
import { RemoteSqlCommitClient } from "./remoteSqlCommitClient";
import type { NodeApiClient } from "./nodeApiClient";

describe("conditional illustration transport", () => {
  it("preserves the read revision and returns a conflict without replaying stale message data", async () => {
    const request = vi.fn(async (_path: string, _options: RequestInit) =>
      Response.json({ revision: 7 }, { status: 409 }),
    );
    const client = new RemoteSqlCommitClient(
      { request } as unknown as NodeApiClient,
      async () => "test-auth",
      "test-client",
    );
    const commit = {
      baseRevision: 2,
      action: "illustration",
      root: { upserts: [], deletes: [] },
      characters: [],
      chats: [],
      chatManifests: [],
      messages: [],
      messageManifests: [],
    };
    await expect(client.commit(commit, 5)).rejects.toMatchObject({
      currentRevision: 7,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(request.mock.calls[0][1].body as string).baseRevision,
    ).toBe(2);
  });
});
