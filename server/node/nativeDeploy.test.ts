import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const nativeDeploy = require("../../tooling/native-deploy.cjs") as {
  parseEnvFile: (filename: string) => Record<string, string>;
  parseInstallArgs: (
    args: string[],
    env?: Record<string, string>,
  ) => {
    options: { build: boolean; start: boolean; skipDbCheck: boolean };
    config: any;
  };
  databaseEnv: (config: any) => Record<string, string>;
  maskedConfig: (config: any) => any;
};

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function tempEnv(contents: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "risu-native-test-"));
  tempDirs.push(dir);
  const filename = path.join(dir, ".env");
  fs.writeFileSync(filename, contents);
  return filename;
}

describe("native deployment configuration", () => {
  it("parses PostgreSQL direct connection options", () => {
    const { config } = nativeDeploy.parseInstallArgs(
      [
        "--db-vendor",
        "postgres",
        "--database-url",
        "postgresql://user:secret@db.example/risuai",
        "--port",
        "7000",
        "--host",
        "0.0.0.0",
      ],
      {},
    );
    expect(config.db.vendor).toBe("postgres");
    expect(config.db.params.connectionString).toContain("db.example");
    expect(config.port).toBe(7000);
    expect(config.host).toBe("0.0.0.0");
    expect(nativeDeploy.databaseEnv(config).DB_VENDOR).toBe("postgres");
    expect(nativeDeploy.maskedConfig(config).db.params.connectionString).toBe(
      "postgresql://user:***@db.example/risuai",
    );
  });

  it("loads Oracle credentials from an env file", () => {
    const envFile = tempEnv(
      `ORACLE_USER=risu\nORACLE_USER_PASSWORD="oracle secret"\nORACLE_TNS_ALIAS=risu_high\nORACLE_WALLET_PATH=/wallet\nORACLE_WALLET_PASSWORD=wallet-secret\n`,
    );
    const { config } = nativeDeploy.parseInstallArgs(
      ["--db-vendor", "oracle", "--env-file", envFile],
      {},
    );
    expect(config.db.params).toMatchObject({
      user: "risu",
      password: "oracle secret",
      tnsAlias: "risu_high",
      walletPath: "/wallet",
    });
    expect(nativeDeploy.maskedConfig(config).db.params.password).toBe("***");
    expect(nativeDeploy.maskedConfig(config).db.params.walletPassword).toBe(
      "***",
    );
  });

  it("loads Azure SQL credentials and port from an env file", () => {
    const envFile = tempEnv(
      `AZURE_HOST=server.database.windows.net\nAZURE_DATABASE=risuai\nAZURE_USERNAME=risu\nAZURE_PASSWORD=azure-secret\nAZURE_PORT=1433\n`,
    );
    const { config } = nativeDeploy.parseInstallArgs(
      ["--db-vendor", "azure", "--env-file", envFile, "--pool-max", "20"],
      {},
    );
    expect(config.db.params).toMatchObject({
      server: "server.database.windows.net",
      database: "risuai",
      user: "risu",
      password: "azure-secret",
      port: 1433,
      poolMax: 20,
    });
    expect(nativeDeploy.databaseEnv(config).AZURE_POOL_MAX).toBe("20");
    expect(nativeDeploy.maskedConfig(config).db.params.password).toBe("***");
  });
});
