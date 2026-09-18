import { describe, expect, it, vi } from "vitest";
import { RemoteLocalBackupClient } from "./remoteLocalBackupClient";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("RemoteLocalBackupClient import API", () => {
  it("uploads the File/Blob body directly without converting it to JSON", async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const apiClient = {
      request: vi.fn(async (path: string, init?: RequestInit) => {
        requests.push({ path, init });
        if (path === "/api/local-backup/import/jobs") {
          return response({ id: "import-1" });
        }
        if (path === "/api/local-backup/import/jobs/import-1/file") {
          return response({
            status: "complete",
            error: null,
            revision: 9,
            recordCount: 12,
          });
        }
        if (path.endsWith("/progress")) {
          return response({
            status: "uploading",
            progress: {
              stage: "uploading",
              current: 10,
              total: 20,
            },
          });
        }
        throw new Error(`unexpected path ${path}`);
      }),
      resolve: (path: string) => `http://localhost${path}`,
    } as any;
    const client = new RemoteLocalBackupClient(
      apiClient,
      async () => "secret",
      "client-1",
    );

    const job = await client.createImportJob();
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const result = await client.uploadImportFile(job.id, blob);
    const progress = await client.getImportProgress(job.id);

    expect(result).toMatchObject({
      status: "complete",
      revision: 9,
      recordCount: 12,
    });
    expect(progress.progress).toMatchObject({
      stage: "uploading",
      current: 10,
      total: 20,
    });
    const upload = requests.find(({ path }) => path.endsWith("/file"))!;
    expect(upload.init?.body).toBe(blob);
    expect(new Headers(upload.init?.headers).get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(new Headers(upload.init?.headers).get("risu-auth")).toBe("secret");
    expect(new Headers(upload.init?.headers).get("x-risu-client-id")).toBe(
      "client-1",
    );
  });

  it("preserves typed API error codes", async () => {
    const apiClient = {
      request: vi.fn(async () =>
        response(
          {
            error: "Account-encrypted backups are intentionally unsupported.",
            code: "encrypted_backup_unsupported",
          },
          400,
        ),
      ),
      resolve: (path: string) => `http://localhost${path}`,
    } as any;
    const client = new RemoteLocalBackupClient(
      apiClient,
      async () => "secret",
      "client-1",
    );

    await expect(client.createImportJob()).rejects.toMatchObject({
      code: "encrypted_backup_unsupported",
      status: 400,
    });
  });
});
