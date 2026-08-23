export type BackupKeyFetch = typeof fetch;
export type BackupDecrypt = (
  data: Uint8Array,
  key: string,
) => Promise<ArrayBuffer>;

export async function fetchLegacyBackupKey(
  timestamp: number,
  fetchImpl: BackupKeyFetch = fetch,
): Promise<string> {
  const response = await fetchImpl(
    `https://sv.risuai.xyz/cryptokey?key=${timestamp}`,
  );

  if (!response.ok) {
    throw new Error(
      `Legacy backup key request failed (${response.status} ${response.statusText || "Unknown status"})`,
    );
  }

  const body = (await response.json()) as { key?: unknown };
  if (typeof body?.key !== "string" || body.key.length === 0) {
    throw new Error("Legacy backup key response did not contain a valid key");
  }

  return body.key;
}

export async function decryptLegacyAccountBackup(
  data: Uint8Array,
  timestamp: number,
  decrypt: BackupDecrypt,
  fetchImpl: BackupKeyFetch = fetch,
): Promise<Uint8Array> {
  const key = await fetchLegacyBackupKey(timestamp, fetchImpl);
  const decrypted = await decrypt(data, key);
  return new Uint8Array(decrypted);
}
