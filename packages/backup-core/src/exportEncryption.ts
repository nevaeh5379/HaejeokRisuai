export interface AccountBackupEncryptionMetadata {
  time: number;
  type: "account";
  databaseEncryption?: string;
}

export interface PrepareAccountBackupEncryptionOptions {
  enabled: boolean;
  metadataEntryName: string;
  requestKey(time: number): Promise<unknown>;
  write(name: string, data: Uint8Array): Promise<void>;
  databaseEncryption?: string;
  now?(): number;
}

function validateEncryptionKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("The backup encryption service returned an invalid key");
  }
  return value;
}

/** Requests an account-backup key and writes its portable metadata entry. */
export async function prepareAccountBackupEncryption(
  options: PrepareAccountBackupEncryptionOptions,
): Promise<string | undefined> {
  if (!options.enabled) return undefined;

  const time: number = (options.now ?? Date.now)();
  const key: string = validateEncryptionKey(await options.requestKey(time));
  const metadata: AccountBackupEncryptionMetadata = {
    time,
    type: "account",
    ...(options.databaseEncryption
      ? { databaseEncryption: options.databaseEncryption }
      : {}),
  };
  const encoded: Uint8Array = new TextEncoder().encode(
    JSON.stringify(metadata),
  );
  await options.write(options.metadataEntryName, encoded);
  return key;
}
