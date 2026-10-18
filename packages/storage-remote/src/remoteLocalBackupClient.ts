import type {
  LocalBackupDatabaseStreamAppendInput,
  LocalBackupDatabaseStreamFinalizeResult,
  LocalBackupDatabaseStreamSession,
  LocalBackupExportJobCompletion,
  LocalBackupExportJobCreateInput,
  LocalBackupExportJobCreated,
  LocalBackupExportJobProgress,
  LocalBackupImportJobCompletion,
  LocalBackupImportJobCreated,
  LocalBackupImportJobProgress,
  LocalBackupImportUploadState,
} from "@risuai/backup-core/api";
import {
  validateLocalBackupDatabaseStreamFinalizeResult,
  validateLocalBackupDatabaseStreamSession,
  validateLocalBackupExportJobCompletion,
  validateLocalBackupExportJobCreated,
  validateLocalBackupExportJobProgress,
  validateLocalBackupImportJobCompletion,
  validateLocalBackupImportJobCreated,
  validateLocalBackupImportJobProgress,
  validateLocalBackupImportUploadState,
} from "@risuai/backup-core/api";
import type { NodeApiClient } from "./nodeApiClient";

// Keep resumable native/Tauri uploads at the server's bounded request limit.
// Browser File restores use the single streaming /file request instead, so
// they do not pay one HTTP round trip and one spool replay per chunk.
export const LOCAL_BACKUP_IMPORT_UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
const LOCAL_BACKUP_IMPORT_REQUEST_ATTEMPTS = 3;

export class RemoteLocalBackupError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly expectedOffset?: number,
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

  private async retryImportRequest<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let lastError: unknown;
    for (
      let attempt = 1;
      attempt <= LOCAL_BACKUP_IMPORT_REQUEST_ATTEMPTS;
      attempt++
    ) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw error;
        const retryable =
          !(error instanceof RemoteLocalBackupError) ||
          error.status === 408 ||
          error.status === 429 ||
          error.status >= 500;
        if (!retryable || attempt === LOCAL_BACKUP_IMPORT_REQUEST_ATTEMPTS) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  private async error(response: Response, fallback: string): Promise<never> {
    const body = await response.json().catch(() => ({}));
    throw new RemoteLocalBackupError(
      typeof body?.error === "string"
        ? body.error
        : `${fallback} (HTTP ${response.status})`,
      typeof body?.code === "string" ? body.code : "local_backup_api_error",
      response.status,
      typeof body?.expectedOffset === "number" &&
        Number.isSafeInteger(body.expectedOffset) &&
        body.expectedOffset >= 0
        ? body.expectedOffset
        : undefined,
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
      return await this.error(
        response,
        "Could not read backup export progress",
      );
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

  async createImportJob(
    signal?: AbortSignal,
  ): Promise<LocalBackupImportJobCreated> {
    const response = await this.apiClient.request(
      "/api/local-backup/import/jobs",
      {
        method: "POST",
        cache: "no-store",
        headers: await this.authHeaders(),
        signal,
      },
    );
    if (!response.ok) {
      return await this.error(response, "Could not create local backup import");
    }
    return validateLocalBackupImportJobCreated(await response.json());
  }

  async getImportProgress(
    id: string,
    signal?: AbortSignal,
  ): Promise<LocalBackupImportJobProgress> {
    const response = await this.apiClient.request(
      `/api/local-backup/import/jobs/${encodeURIComponent(id)}/progress`,
      {
        method: "GET",
        cache: "no-store",
        headers: await this.authHeaders(),
        signal,
      },
    );
    if (!response.ok) {
      return await this.error(
        response,
        "Could not read backup import progress",
      );
    }
    return validateLocalBackupImportJobProgress(await response.json());
  }

  async waitForImport(
    id: string,
    signal?: AbortSignal,
  ): Promise<LocalBackupImportJobCompletion> {
    const response = await this.apiClient.request(
      `/api/local-backup/import/jobs/${encodeURIComponent(id)}`,
      {
        method: "GET",
        cache: "no-store",
        headers: await this.authHeaders(),
        signal,
      },
    );
    if (!response.ok) {
      return await this.error(response, "Local backup import failed");
    }
    return validateLocalBackupImportJobCompletion(await response.json());
  }

  async uploadImportFile(
    id: string,
    file: Blob,
    uploadToken: string,
    signal?: AbortSignal,
  ): Promise<LocalBackupImportJobCompletion> {
    const response = await this.apiClient.request(
      `/api/local-backup/import/jobs/${encodeURIComponent(id)}/file`,
      {
        method: "PUT",
        cache: "no-store",
        headers: {
          "content-type": "application/octet-stream",
          "x-risu-backup-upload-token": uploadToken,
          "x-risu-client-id": this.clientId,
        },
        body: file,
        signal,
      },
    );
    if (!response.ok) {
      return await this.error(response, "Could not import local backup");
    }
    return validateLocalBackupImportJobCompletion(await response.json());
  }

  async appendImportChunk(
    id: string,
    offset: number,
    chunk: Uint8Array,
    totalBytes: number,
    signal?: AbortSignal,
  ): Promise<LocalBackupImportUploadState> {
    const query = new URLSearchParams({
      offset: String(offset),
      totalBytes: String(totalBytes),
    });
    const response = await this.apiClient.request(
      `/api/local-backup/import/jobs/${encodeURIComponent(id)}/chunks?${query.toString()}`,
      {
        method: "PUT",
        cache: "no-store",
        headers: {
          "content-type": "application/octet-stream",
          ...(await this.authHeaders()),
        },
        body: new Uint8Array(chunk).buffer,
        signal,
      },
    );
    if (!response.ok) {
      return await this.error(response, "Could not upload local backup chunk");
    }
    return validateLocalBackupImportUploadState(await response.json());
  }

  async finalizeImportUpload(
    id: string,
    signal?: AbortSignal,
  ): Promise<LocalBackupImportJobCompletion> {
    const response = await this.apiClient.request(
      `/api/local-backup/import/jobs/${encodeURIComponent(id)}/finalize-upload`,
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
        "Could not finalize local backup upload",
      );
    }
    return validateLocalBackupImportJobCompletion(await response.json());
  }

  async cancelImportJob(id: string, signal?: AbortSignal): Promise<void> {
    const response = await this.apiClient.request(
      `/api/local-backup/import/jobs/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        cache: "no-store",
        headers: await this.authHeaders(),
        signal,
      },
    );
    if (!response.ok && response.status !== 404) {
      await this.error(response, "Could not cancel local backup import");
    }
  }

  async uploadImportStream(
    id: string,
    source: ReadableStream<Uint8Array>,
    totalBytes: number,
    options: {
      signal?: AbortSignal;
      chunkSize?: number;
      onProgress?: (state: LocalBackupImportUploadState) => void;
    } = {},
  ): Promise<LocalBackupImportJobCompletion> {
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
      throw new TypeError(
        "Local backup upload size must be a positive safe integer",
      );
    }
    const chunkSize =
      options.chunkSize ?? LOCAL_BACKUP_IMPORT_UPLOAD_CHUNK_SIZE;
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
      throw new TypeError(
        "Local backup upload chunk size must be a positive safe integer",
      );
    }

    const reader = source.getReader();
    let buffer = new Uint8Array(chunkSize);
    let buffered = 0;
    let offset = 0;
    const flush = async () => {
      if (buffered === 0) return;
      const requestOffset = offset;
      const requestChunk = buffer.slice(0, buffered);
      const state = await this.retryImportRequest(
        async () =>
          await this.appendImportChunk(
            id,
            requestOffset,
            requestChunk,
            totalBytes,
            options.signal,
          ),
        options.signal,
      );
      offset = state.receivedBytes;
      buffered = 0;
      options.onProgress?.(state);
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        if (offset + buffered + value.byteLength > totalBytes) {
          throw new Error("Local backup source exceeded its declared size");
        }

        let sourceOffset = 0;
        while (sourceOffset < value.byteLength) {
          const copyLength = Math.min(
            chunkSize - buffered,
            value.byteLength - sourceOffset,
          );
          buffer.set(
            value.subarray(sourceOffset, sourceOffset + copyLength),
            buffered,
          );
          buffered += copyLength;
          sourceOffset += copyLength;
          if (buffered === chunkSize) await flush();
        }
      }
      await flush();
      if (offset !== totalBytes) {
        throw new Error(
          `Local backup source ended early: ${offset} / ${totalBytes} bytes`,
        );
      }
      return await this.retryImportRequest(
        async () => await this.finalizeImportUpload(id, options.signal),
        options.signal,
      );
    } catch (error) {
      await reader.cancel().catch(() => {});
      await this.cancelImportJob(id).catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
      buffer = new Uint8Array();
    }
  }

  async openExportStream(id: string, signal?: AbortSignal): Promise<Response> {
    const response = await this.apiClient.request(
      `/api/local-backup/export/${encodeURIComponent(id)}`,
      {
        method: "GET",
        cache: "no-store",
        headers: await this.authHeaders(),
        signal,
      },
    );
    if (!response.ok) {
      return await this.error(response, "Local backup download failed");
    }
    return response;
  }

  async getExportDownloadUrl(id: string): Promise<string> {
    const auth = await this.getAuth();
    return this.apiClient.resolve(
      `/api/local-backup/export/${encodeURIComponent(id)}?auth=${encodeURIComponent(auth)}`,
    );
  }
}
