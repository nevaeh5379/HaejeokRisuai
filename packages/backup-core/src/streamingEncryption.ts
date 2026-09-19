const STREAMING_BACKUP_ENCRYPTION_MAGIC = new TextEncoder().encode("RISUDBE1");
const STREAMING_BACKUP_ENCRYPTION_IV_LENGTH = 12;

export const STREAMING_BACKUP_ENCRYPTION_FORMAT =
  "aes-gcm-random-iv-v1" as const;

function asWebCryptoBuffer(
  value: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  return value as unknown as Uint8Array<ArrayBuffer>;
}

async function deriveStreamingBackupKey(
  secret: string,
  cryptoImpl: Crypto,
): Promise<CryptoKey> {
  const keyBytes = await cryptoImpl.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return await cryptoImpl.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function hasMagic(data: Uint8Array): boolean {
  if (data.byteLength < STREAMING_BACKUP_ENCRYPTION_MAGIC.byteLength) {
    return false;
  }
  return STREAMING_BACKUP_ENCRYPTION_MAGIC.every(
    (byte, index) => data[index] === byte,
  );
}

export function isStreamingBackupEncryptedEntry(data: Uint8Array): boolean {
  return hasMagic(data);
}

export async function encryptStreamingBackupEntry(
  data: Uint8Array,
  secret: string,
  entryName: string,
  cryptoImpl: Crypto = globalThis.crypto,
): Promise<Uint8Array> {
  const iv = cryptoImpl.getRandomValues(
    new Uint8Array(STREAMING_BACKUP_ENCRYPTION_IV_LENGTH),
  );
  const key = await deriveStreamingBackupKey(secret, cryptoImpl);
  const encrypted = new Uint8Array(
    await cryptoImpl.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: asWebCryptoBuffer(iv),
        additionalData: asWebCryptoBuffer(new TextEncoder().encode(entryName)),
      },
      key,
      asWebCryptoBuffer(data),
    ),
  );
  const output = new Uint8Array(
    STREAMING_BACKUP_ENCRYPTION_MAGIC.byteLength +
      iv.byteLength +
      encrypted.byteLength,
  );
  output.set(STREAMING_BACKUP_ENCRYPTION_MAGIC, 0);
  output.set(iv, STREAMING_BACKUP_ENCRYPTION_MAGIC.byteLength);
  output.set(
    encrypted,
    STREAMING_BACKUP_ENCRYPTION_MAGIC.byteLength + iv.byteLength,
  );
  return output;
}

export async function decryptStreamingBackupEntry(
  data: Uint8Array,
  secret: string,
  entryName: string,
  cryptoImpl: Crypto = globalThis.crypto,
): Promise<Uint8Array> {
  const payloadOffset =
    STREAMING_BACKUP_ENCRYPTION_MAGIC.byteLength +
    STREAMING_BACKUP_ENCRYPTION_IV_LENGTH;
  if (!hasMagic(data) || data.byteLength <= payloadOffset) {
    throw new Error("Invalid streaming backup encryption envelope");
  }
  const iv = data.subarray(
    STREAMING_BACKUP_ENCRYPTION_MAGIC.byteLength,
    payloadOffset,
  );
  const encrypted = data.subarray(payloadOffset);
  const key = await deriveStreamingBackupKey(secret, cryptoImpl);
  return new Uint8Array(
    await cryptoImpl.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: asWebCryptoBuffer(iv),
        additionalData: asWebCryptoBuffer(new TextEncoder().encode(entryName)),
      },
      key,
      asWebCryptoBuffer(encrypted),
    ),
  );
}
