import { describe, expect, it, vi } from "vitest";
import { RemoteLocalBackupClient } from "./remoteLocalBackupClient";
import { NodeApiClient } from "./nodeApiClient";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("RemoteLocalBackupClient import API", () => {
  it("uploads the File/Blob body directly without converting it to JSON", async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const apiClient = new NodeApiClient({
      version: 1,
      mode: "remote",
      baseUrl: "test",
      allowInsecureHttp: true
    })

    vi.spyOn(apiClient, "request").mockImplementation(async (path: string, init?: RequestInit): ReturnType<typeof apiClient.request> => {
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
    })

    vi.spyOn(apiClient, "resolve").mockImplementation((path: string): string => `http://localhost${path}`)
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

  it("uploads a ReadableStream through bounded offset chunks and finalizes it", async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    let received = 0;
    const apiClient = {
      request: vi.fn(async (path: string, init?: RequestInit) => {
        requests.push({ path, init });
        if (path === "/api/local-backup/import/jobs") {
          return response({ id: "import-stream" });
        }
        if (
          path.startsWith("/api/local-backup/import/jobs/import-stream/chunks?")
        ) {
          const url = new URL(path, "http://localhost");
          const offset = Number(url.searchParams.get("offset"));
          const totalBytes = Number(url.searchParams.get("totalBytes"));
          expect(offset).toBe(received);
          expect(totalBytes).toBe(7);
          const chunk = new Uint8Array(
            await new Response(init?.body as BodyInit).arrayBuffer(),
          );
          received += chunk.byteLength;
          return response({
            receivedBytes: received,
            totalBytes,
            complete: received === totalBytes,
          });
        }
        if (
          path === "/api/local-backup/import/jobs/import-stream/finalize-upload"
        ) {
          expect(received).toBe(7);
          return response({
            status: "complete",
            error: null,
            revision: 14,
            recordCount: 2,
          });
        }
        if (
          path === "/api/local-backup/import/jobs/import-stream" &&
          init?.method === "DELETE"
        ) {
          throw new Error("successful upload must not be cancelled");
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
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6, 7]));
        controller.close();
      },
    });
    const progress: number[] = [];

    await expect(
      client.uploadImportStream(job.id, source, 7, {
        chunkSize: 4,
        onProgress: (state) => progress.push(state.receivedBytes),
      }),
    ).resolves.toEqual({
      status: "complete",
      error: null,
      revision: 14,
      recordCount: 2,
    });

    expect(progress).toEqual([4, 7]);
    const chunks = requests.filter(({ path }) => path.includes("/chunks?"));
    expect(chunks).toHaveLength(2);
    expect(chunks.map(({ init }) => init?.method)).toEqual(["PUT", "PUT"]);
    expect(
      chunks.map(({ init }) => new Headers(init?.headers).get("content-type")),
    ).toEqual(["application/octet-stream", "application/octet-stream"]);
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

describe("RemoteLocalBackupClient export API", () => {
  it("uses the shared export job contract and authenticated download URL", async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const apiClient = {
      request: vi.fn(async (path: string, init?: RequestInit) => {
        requests.push({ path, init });
        if (path.startsWith("/api/local-backup/export/jobs?")) {
          return response({ id: "export 1" });
        }
        if (path.endsWith("/progress")) {
          return response({
            status: "streaming",
            progress: { stage: "assets", current: 2, total: 5 },
          });
        }
        if (path === "/api/local-backup/export/jobs/export%201") {
          return response({ status: "complete", error: null });
        }
        if (path === "/api/local-backup/export/export%201") {
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
        }
        throw new Error(`unexpected path ${path}`);
      }),
      resolve: (path: string) => `https://backup.example${path}`,
    } as any;
    const client = new RemoteLocalBackupClient(
      apiClient,
      async () => "secret token",
      "client-1",
    );

    const job = await client.createExportJob({
      mode: "partial",
      pageSize: 64,
      fragmentRecords: 32,
    });
    const progress = await client.getExportProgress(job.id);
    const completion = await client.waitForExport(job.id);
    const streamed = await client.openExportStream(job.id);
    const downloadUrl = await client.getExportDownloadUrl(job.id);

    expect(job).toEqual({ id: "export 1" });
    expect(progress).toEqual({
      status: "streaming",
      progress: { stage: "assets", current: 2, total: 5 },
    });
    expect(completion).toEqual({ status: "complete", error: null });
    expect([...new Uint8Array(await streamed.arrayBuffer())]).toEqual([
      1, 2, 3,
    ]);
    const streamRequest = requests.find(
      ({ path }) => path === "/api/local-backup/export/export%201",
    )!;
    expect(new Headers(streamRequest.init?.headers).get("risu-auth")).toBe(
      "secret token",
    );
    expect(
      new Headers(streamRequest.init?.headers).get("x-risu-client-id"),
    ).toBe("client-1");
    expect(downloadUrl).toBe(
      "https://backup.example/api/local-backup/export/export%201?auth=secret%20token",
    );

    const create = requests[0];
    expect(create.path).toBe(
      "/api/local-backup/export/jobs?mode=partial&pageSize=64&fragmentRecords=32",
    );
    expect(create.init?.method).toBe("POST");
    expect(new Headers(create.init?.headers).get("risu-auth")).toBe(
      "secret token",
    );
    expect(new Headers(create.init?.headers).get("x-risu-client-id")).toBe(
      "client-1",
    );
  });
});
