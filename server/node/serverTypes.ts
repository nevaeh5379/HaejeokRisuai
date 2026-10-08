import type { PostgresStorageContract } from "./storage/postgres/postgresStorage.cjs";
import type { LocalBackupImportRecordStore } from "./sync/localBackupImportRecords.js";
import type { PluginStorageRouteDependencies } from "./api/database/plugins/routes.js";
import type { Request as ExpressRequest } from "express";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { WebSocket } from "ws";

// Legacy SQL settings, character cards and provider payloads have extensible
// schemas. Keep their dynamic fields at the CommonJS boundary.
export type LegacyObject = Record<string, any>;
export type SqlVendor = "postgres" | "oracle" | "azure";
export type SqlValidationState = {
  sourceRevision: number | null;
  entityPhase: boolean;
};
export interface ServerError extends Error {
  code?: string;
  recordIndex?: number;
  currentRevision?: number;
  revision?: number;
  expectedOffset?: number;
  type?: string;
  status?: number;
  statusCode?: number;
  startupOperation?: string;
}
export interface PrimaryStorageFailure {
  code: string;
  message: string;
  hint: string;
  operation: string;
  failedAt: string;
}
export interface PrimaryStorageRuntime {
  status: "starting" | "unconfigured" | "ready" | "degraded";
  vendor: SqlVendor;
  error: PrimaryStorageFailure | null;
  attemptStartedAt: string | null;
  readyAt: string | null;
}
export interface BackupConfig {
  vendor: SqlVendor | null;
  enabled: boolean;
  poolMax: number;
  params: LegacyObject;
  mirroring: { enabled: boolean };
  snapshot: { enabled: boolean; intervalMinutes: number };
}
export interface BackupRuntime {
  initialized: boolean;
  lastMirrorAt: string | null;
  lastMirrorError: string | null;
  lastSnapshotAt: string | null;
  lastSnapshotError: string | null;
  lastFullSyncAt: string | null;
  lastFullSyncError: string | null;
  inFlight: boolean;
}
export interface AssetEntry {
  key: string;
  size?: number | null;
  mtime?: number;
  updatedAt?: number;
}
export interface AssetReadResult {
  exists: boolean;
  stream?: AsyncIterable<Uint8Array>;
  buffer?: Buffer;
  contentLength?: number;
  contentType?: string;
  filePath?: string;
}
export interface AssetStorage {
  type: string;
  read(key: string): Promise<AssetReadResult>;
  openReadStream?(key: string): Promise<AssetReadResult>;
  list(prefix: string): Promise<string[]>;
  getAssetDetails(): Promise<{ assets: AssetEntry[] }>;
}
export interface CharxExportEntry {
  name?: string;
  source?: string;
  dataBase64?: string;
}
export interface CharxExportBody {
  entries: CharxExportEntry[];
  filename?: string;
  previewSource?: string;
}
export interface CharxExportJob {
  body: CharxExportBody;
  status: "pending" | "streaming" | "complete" | "error";
  error: string | null;
  completion: Promise<void>;
  resolveCompletion(): void;
  expiresAt: number;
}
export type Request = ExpressRequest<Record<string, string>> & {
  charxExportJob?: CharxExportJob;
};
export interface ProxyStreamArgs {
  targetUrl: string;
  method: string;
  headers?: unknown;
  bodyBase64?: string;
  clientIp?: string;
  timeoutMs?: number;
  heartbeatSec?: number;
}
export interface UpstreamRequestArgs {
  method: string;
  headers?: unknown;
  bodyBuffer?: Buffer;
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: IncomingMessage;
}
export interface ProxyStreamJob {
  id: string;
  createdAt: number;
  updatedAt: number;
  done: boolean;
  cleanupAt: number;
  clients: Set<WebSocket>;
  pendingEvents: string[];
  pendingBytes: number;
  abortController: AbortController;
  deadlineAt: number;
  heartbeatSec: number;
  timeoutMs: number;
}
export type AuthRequest = {
  headers: IncomingHttpHeaders;
  query?: Record<string, unknown>;
};

// The SQL drivers share the Postgres API plus the base class contracts used
// by restore and plugin routes; the base class is still a CommonJS module.
export type ServerSqlStorage = PostgresStorageContract &
  ReturnType<ConstructorParameters<typeof LocalBackupImportRecordStore>[0]> &
  ReturnType<PluginStorageRouteDependencies["getStorage"]>;
