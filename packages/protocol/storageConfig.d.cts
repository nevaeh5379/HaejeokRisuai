export const SQL_DATABASE_VENDORS: readonly ["postgres", "oracle", "azure"];
export type DbVendor = (typeof SQL_DATABASE_VENDORS)[number];

export const SQL_RUNTIME_STATUSES: readonly [
  "starting",
  "ready",
  "degraded",
  "unconfigured",
];
export type SqlStorageRuntimeStatus = (typeof SQL_RUNTIME_STATUSES)[number];

export const ASSET_STORAGE_TYPES: readonly ["fs", "s3", "azuresql"];
export type AssetStorageType = (typeof ASSET_STORAGE_TYPES)[number];
export type AssetStorageTarget = "active" | AssetStorageType;

export interface NodeSqlStorageRuntimeError {
  code: string;
  message: string;
  hint: string;
  operation: string;
  failedAt: string;
}

export interface NodeSqlStorageRuntime {
  status: SqlStorageRuntimeStatus;
  vendor: DbVendor;
  error: NodeSqlStorageRuntimeError | null;
  attemptStartedAt: string | null;
  readyAt: string | null;
}

export interface NodePostgresServerConfig {
  enabled: boolean;
  configured: boolean;
  managedByEnvironment: boolean;
  vendor: DbVendor;
  connectionDisplay: string;
  poolMax: number;
  revision: number | null;
  initialized: boolean;
  runtime?: NodeSqlStorageRuntime;
}

export interface NodePostgresServerConfigUpdate {
  enabled: boolean;
  connectionString?: string;
  poolMax: number;
  legacySnapshotReady?: boolean;
}

export interface NodeS3ServerConfig {
  enabled: boolean;
  storageType: AssetStorageType;
  endpoint: string;
  bucket: string;
  region: string;
  forcePathStyle: boolean;
  autoCreateBucket: boolean;
  accessKeyId: string;
  hasSecretAccessKey: boolean;
  accessKeyDisplay: string;
  managedByEnvironment: boolean;
  azureServer: string;
  azureDatabase: string;
  azureUser: string;
  azurePort: number;
  hasAzurePassword: boolean;
  azureManagedByEnvironment: boolean;
  s3ManagedByEnvironment: boolean;
}

export interface NodeS3ServerConfigUpdate {
  enabled: boolean;
  storageType?: AssetStorageType;
  endpoint?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  forcePathStyle?: boolean;
  autoCreateBucket?: boolean;
  azureServer?: string;
  azureDatabase?: string;
  azureUser?: string;
  azurePassword?: string;
  azurePort?: number;
}

export interface NodeS3TestResult {
  success: boolean;
  bucketExists: boolean;
  message: string;
}

export interface NodeS3Stats {
  storageType: AssetStorageType;
  bucketName?: string;
  endpoint?: string;
  totalObjects: number;
  totalSizeBytes: number;
  listSource?: "catalog" | "storage";
}

export interface NodeS3MigrationResult {
  total: number;
  migrated: number;
  skipped: number;
  errors: string[];
}

export interface NodeS3RollbackResult {
  total: number;
  downloaded: number;
  errors: string[];
}

export interface NodeS3ThumbnailsResult {
  total: number;
  created: number;
  skipped: number;
  errors: string[];
}

export interface NodeStorageSummary {
  activeType: AssetStorageType;
  localFs: NodeS3Stats;
  s3: NodeS3Stats | null;
  azuresql: NodeS3Stats | null;
  config: NodeS3ServerConfig;
}

export interface NodeStorageAssetItem {
  key: string;
  size: number;
  mtime: number;
}

export interface NodeStorageAssetDetails {
  storageType: AssetStorageType;
  bucketName?: string;
  endpoint?: string;
  totalObjects: number;
  totalSizeBytes: number;
  assets: NodeStorageAssetItem[];
  listSource?: "catalog" | "storage" | "storage-sync";
  catalogEmpty?: boolean;
}

export interface NodeS3ProgressEvent {
  type: "progress";
  current: number;
  total: number;
  migrated?: number;
  skipped?: number;
  downloaded?: number;
  created?: number;
  percentage: number;
  currentKey?: string;
}
