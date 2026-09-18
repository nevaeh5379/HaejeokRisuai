import type {
  LocalBackupDatabaseStreamAppendInput,
  LocalBackupDatabaseStreamFinalizeResult,
  LocalBackupDatabaseStreamSession,
  LocalBackupExportJobCompletion,
  LocalBackupExportJobCreateInput,
  LocalBackupExportJobCreated,
  LocalBackupExportJobProgress,
} from "@risuai/backup-core/api";
import {
  validateLocalBackupDatabaseStreamFinalizeResult,
  validateLocalBackupDatabaseStreamSession,
  validateLocalBackupExportJobCompletion,
  validateLocalBackupExportJobCreated,
  validateLocalBackupExportJobProgress,
} from "@risuai/backup-core/api";
import type { NodeApiClient } from "./nodeApiClient";

export class RemoteLocalBackupError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RemoteLocalBackupError";
  }
}

export class RemoteLocalBackupClient {
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

  private async error(response: Response, fallback: string): Promise<never> {
    const body = await response.json().catch(() => ({}));
    throw new RemoteLocalBackupError(
      typeof body?.error === "string"
        ? body.error
        : `${fallback} (HTTP ${response.status})`,
      typeof body?.code === "string" ? body.code : "local_backup_api_error",
      response.status,
    );
  }

  async createDatabaseStreamSession(
    signal?: AbortSignal,
  ): Promise<LocalBackupDatabaseStreamSession> {
    const response = await this.apiClient.request(
      "/api/local-backup/database-stream/sessions",
      {
        method: "POST",
        cache: "no-store",
        headers: await this.authHeaders(),
        signal,
      },
    );
    if (!response.ok) {
      return await this.error(
        response,
        "Could not create local backup database stream session",
      );
    }
    return validateLocalBackupDatabaseStreamSession(await response.json());
  }

  async appendDatabaseStreamRecords(
    id: string,
    input: LocalBackupDatabaseStreamAppendInput,
    signal?: AbortSignal,
  ): Promise<LocalBackupDatabaseStreamSession> {
    const response = await this.apiClient.request(
      `/api/local-backup/database-stream/sessions/${encodeURIComponent(id)}/records`,
      {
        method: "PUT",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          ...(await this.authHeaders()),
        },
        body: JSON.stringify(input),
        signal,
      },
    );
    if (!response.ok) {
      return await this.error(
        response,
        "Could not append local backup database records",
      );
    }
    return validateLocalBackupDatabaseStreamSession(await response.json());
  }

  async finalizeDatabaseStream(
    id: string,
    manifest: unknown,
    signal?: AbortSignal,
  ): Promise<LocalBackupDatabaseStreamFinalizeResult> {
    const response = await this.apiClient.request(
      `/api/local-backup/database-stream/sessions/${encodeURIComponent(id)}/finalize`,
      {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          ...(await this.authHeaders()),
        },
        body: JSON.stringify({ manifest }),
        signal,
      },
    );
    if (!response.ok) {
      return await this.error(
        response,
        "Could not finalize local backup database restore",
      );
    }
    return validateLocalBackupDatabaseStreamFinalizeResult(
      await response.json(),
    );
  }

  async cancelDatabaseStream(id: string): Promise<void> {
    const response = await this.apiClient.request(
      `/api/local-backup/database-stream/sessions/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        cache: "no-store",
        headers: await this.authHeaders(),
      },
    );
    if (!response.ok && response.status !== 404) {
      await this.error(response, "Could not cancel local backup restore");
    }
  }

  async createExportJob(
    input: LocalBackupExportJobCreateInput,
    signal?: AbortSignal,
  ): Promise<LocalBackupExportJobCreated> {
    const query = new URLSearchParams({
      mode: input.mode,
      pageSize: String(input.pageSize),
      fragmentRecords: String(input.fragmentRecords),
    });
    const response = await this.apiClient.request(
      `/api/local-backup/export/jobs?${query.toString()}`,
      {
        method: "POST",
        cache: "no-store",
        headers: await this.authHeaders(),
        signal,
      },
    );
    if (!response.ok) {
      return await this.error(response, "Could not create local backup export");
    }
    return validateLocalBackupExportJobCreated(await response.json());
  }

  async getExportProgress(
    id: string,
    signal?: AbortSignal,
  ): Promise<LocalBackupExportJobProgress> {
    const response = await this.apiClient.request(
      `/api/local-backup/export/jobs/${encodeURIComponent(id)}/progress`,
      {
        method: "GET",
        cache: "no-store",
        headers: await this.authHeaders(),
        signal,
      },
    );
    if (!response.ok) {
      return await this.error(response, "Could not read backup export progress");
    }
    return validateLocalBackupExportJobProgress(await response.json());
  }

  async waitForExport(
    id: string,
    signal?: AbortSignal,
  ): Promise<LocalBackupExportJobCompletion> {
    const response = await this.apiClient.request(
      `/api/local-backup/export/jobs/${encodeURIComponent(id)}`,
      {
        method: "GET",
        cache: "no-store",
        headers: await this.authHeaders(),
        signal,
      },
    );
    if (!response.ok) {
      return await this.error(response, "Local backup export failed");
    }
    return validateLocalBackupExportJobCompletion(await response.json());
  }

  async getExportDownloadUrl(id: string): Promise<string> {
    const auth = await this.getAuth();
    return this.apiClient.resolve(
      `/api/local-backup/export/${encodeURIComponent(id)}?auth=${encodeURIComponent(auth)}`,
    );
  }
}
