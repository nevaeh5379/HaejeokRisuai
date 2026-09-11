import type {
  SqlCommit,
  SqlCommitResult,
} from "@risuai/protocol/sqlCommit.cjs";
import type { NodeApiClient } from "./nodeApiClient";

export class NodeSqlRevisionConflictError extends Error {
  readonly currentRevision: number | null;

  constructor(revision: unknown) {
    super(
      `PostgreSQL data changed in another session (server revision ${revision ?? "unknown"}). Reload before saving again.`,
    );
    this.name = "NodeSqlRevisionConflictError";
    this.currentRevision = Number.isSafeInteger(Number(revision))
      ? Number(revision)
      : null;
  }
}

export class NodeSqlPayloadTooLargeError extends Error {
  constructor(message?: string) {
    super(
      message ||
        "PostgreSQL save payload is larger than the Node server allows.",
    );
    this.name = "NodeSqlPayloadTooLargeError";
  }
}

async function encodeJsonBody(payload: unknown): Promise<{
  body: BodyInit;
  contentEncoding?: string;
}> {
  const json = JSON.stringify(payload);
  if (json.length < 64 * 1024 || typeof CompressionStream === "undefined") {
    return { body: json };
  }
  const compressed = new Blob([json])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return {
    body: await new Response(compressed).arrayBuffer(),
    contentEncoding: "gzip",
  };
}

async function responseError(
  response: Response,
  fallback: string,
): Promise<Error> {
  const body = await response.json().catch(() => null);
  return new Error(body?.error || `${fallback} (${response.status})`);
}

export class RemoteSqlCommitClient {
  constructor(
    private readonly apiClient: NodeApiClient,
    private readonly getAuth: () => Promise<string>,
    private readonly clientId: string,
  ) {}

  private async authHeaders(): Promise<Record<string, string>> {
    return {
      "risu-auth": await this.getAuth(),
      "x-risu-client-id": this.clientId,
    };
  }

  async commit<TPreset extends object>(
    commit: SqlCommit<TPreset>,
    currentRevision: number,
  ): Promise<SqlCommitResult> {
    let pending: SqlCommit<TPreset> = {
      ...commit,
      baseRevision: Math.max(commit.baseRevision, currentRevision),
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      const encodedBody = await encodeJsonBody(pending);
      const response = await this.apiClient.request("/api/database-v2/commit", {
        method: "POST",
        body: encodedBody.body,
        headers: {
          "content-type": "application/json",
          ...(encodedBody.contentEncoding
            ? { "content-encoding": encodedBody.contentEncoding }
            : {}),
          ...(await this.authHeaders()),
        },
      });

      if (response.status === 409) {
        const conflict = await response.json().catch(() => null);
        const revision = Number(conflict?.revision);
        if (Number.isSafeInteger(revision) && attempt < 2) {
          pending = { ...pending, baseRevision: revision };
          continue;
        }
        throw new NodeSqlRevisionConflictError(conflict?.revision);
      }

      if (response.status === 413) {
        const body = await response.json().catch(() => null);
        throw new NodeSqlPayloadTooLargeError(body?.error);
      }

      if (response.status < 200 || response.status >= 300) {
        throw await responseError(response, "SQL commit failed");
      }
      return (await response.json()) as SqlCommitResult;
    }

    throw new NodeSqlRevisionConflictError(currentRevision);
  }
}
