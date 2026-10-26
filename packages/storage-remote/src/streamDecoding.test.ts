import { expect, it, vi } from "vitest";
import { NodeApiClient } from "./nodeApiClient";
import { NodeS3Storage } from "./nodeS3Storage";
import { RemoteDatabaseBackupClient } from "./remoteDatabaseBackupClient";

it.each(["resync", "restore", "migrate", "rollback", "thumbnails"] as const)(
  "%s does not inherit UTF-8 bytes from an interrupted operation",
  async (operation) => {
    const api = new NodeApiClient({
      version: 1,
      mode: "remote",
      baseUrl: "test",
      allowInsecureHttp: true,
    });
    let reads = 0;
    const interrupted = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (reads++ === 0) {
            // End inside the three-byte UTF-8 encoding of 한.
            const bytes = new TextEncoder().encode('{"message":"한');
            controller.enqueue(bytes.subarray(0, bytes.length - 2));
          } else {
            controller.error(new Error("connection lost"));
          }
        },
      },
      { highWaterMark: 0 },
    );
    vi.spyOn(api, "request")
      .mockResolvedValueOnce(new Response(interrupted))
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  '{"type":"error","error":"operation failed"}\n',
                ),
              );
              controller.close();
            },
          }),
        ),
      );
    const backup = new RemoteDatabaseBackupClient(
      api,
      async () => "auth",
      "id",
    );
    const s3 = new NodeS3Storage(async () => "auth", api);
    const run = {
      resync: () => backup.resync(),
      restore: () => backup.restore(),
      migrate: () => s3.migrateLocalToS3(),
      rollback: () => s3.rollbackS3ToLocal(),
      thumbnails: () => s3.generateMissingThumbnails(),
    }[operation];

    await expect(run()).rejects.toThrow("connection lost");
    await expect(run()).rejects.toThrow("operation failed");
  },
);
