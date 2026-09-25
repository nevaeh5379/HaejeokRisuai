export type BackupVendor = "postgres" | "oracle" | "azure";

export type BackupParams = {
  connectionString?: string;
  poolMax?: number;
  user?: string;
  tnsAlias?: string;
  walletPath?: string;
  password?: string;
  walletPassword?: string;
  server?: string;
  database?: string;
  port?: number;
};

export namespace BackupParams {
  export type Postgres = {
    connectionString?: string;
    poolMax?: number;
  };

  export type Oracle = {
    user?: string;
    tnsAlias?: string;
    walletPath?: string;
    password?: string;
    walletPassword?: string;
    poolMax?: number;
  };

  export type Azure = {
    server?: string;
    database?: string;
    user?: string;
    password?: string;
    port?: number;
    poolMax?: number;
  };
}

export type MaskedBackupParams =
  | MaskedBackupParams.Postgres
  | MaskedBackupParams.Oracle
  | MaskedBackupParams.Azure;

export namespace MaskedBackupParams {
  export type Postgres = {
    connectionString: string;
    poolMax: number;
  };

  export type Oracle = {
    user: string;
    tnsAlias: string;
    walletPath: string;
    poolMax: number;
    hasPassword: boolean;
    hasWalletPassword: boolean;
  };

  export type Azure = {
    server: string;
    database: string;
    user: string;
    port: number;
    poolMax: number;
    hasPassword: boolean;
  };
}

