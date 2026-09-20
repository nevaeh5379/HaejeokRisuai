import { describe, expect, it } from "vitest";
import {
  STREAMING_BACKUP_ENCRYPTION_FORMAT,
  decodeStreamingBackupValue,
  decryptStreamingBackupEntry,
  encodeStreamingBackupValue,
  encryptStreamingBackupEntry,
  isStreamingBackupEncryptedEntry,
} from "./streamingEncryption";

describe("streaming backup encryption", () => {
  it("keeps the envelope format identifier stable", () => {
    expect(STREAMING_BACKUP_ENCRYPTION_FORMAT).toBe("aes-gcm-random-iv-v1");
  });

  it("uses a fresh authenticated envelope for every entry", async () => {
    const data = new TextEncoder().encode("database fragment");
    const name = "database.stream/000000000001.risudat";

    const first = await encryptStreamingBackupEntry(data, "secret", name);
    const second = await encryptStreamingBackupEntry(data, "secret", name);

    expect(isStreamingBackupEncryptedEntry(first)).toBe(true);
    expect(first).not.toEqual(second);
    await expect(
      decryptStreamingBackupEntry(first, "secret", name),
    ).resolves.toEqual(data);
  });

  it("authenticates the entry name", async () => {
    const data = new TextEncoder().encode("manifest");
    const encrypted = await encryptStreamingBackupEntry(
      data,
      "secret",
      "database.stream/manifest.risudat",
    );

    await expect(
      decryptStreamingBackupEntry(
        encrypted,
        "secret",
        "database.stream/000000000001.risudat",
      ),
    ).rejects.toThrow();
  });

  it("rejects malformed envelopes before decrypting", async () => {
    await expect(
      decryptStreamingBackupEntry(
        new TextEncoder().encode("not-an-envelope"),
        "secret",
        "database.stream/manifest.risudat",
      ),
    ).rejects.toThrow("Invalid streaming backup encryption envelope");
  });

  it("round-trips encoded values through the authenticated entry envelope", async (): Promise<void> => {
    const name: string = "database.stream/manifest.risudat";
    const encoded: Uint8Array = await encodeStreamingBackupValue(
      { revision: 3 },
      name,
      async (value: unknown): Promise<Uint8Array> =>
        new TextEncoder().encode(JSON.stringify(value)),
      "secret",
    );

    const decoded: unknown = await decodeStreamingBackupValue(
      encoded,
      name,
      async (data: Uint8Array): Promise<unknown> =>
        JSON.parse(new TextDecoder().decode(data)) as unknown,
      {
        secret: "secret",
        async decryptLegacy(
          _data: Uint8Array,
          _secret: string,
        ): Promise<Uint8Array> {
          throw new Error("legacy decryptor must not be used");
        },
      },
    );

    expect(decoded).toEqual({ revision: 3 });
  });

  it("uses the injected decryptor for legacy encrypted entries", async (): Promise<void> => {
    const legacyData: Uint8Array = new Uint8Array([9]);
    let decryptCalls: number = 0;

    const decoded: unknown = await decodeStreamingBackupValue(
      legacyData,
      "database.stream/000000000001.risudat",
      async (data: Uint8Array): Promise<unknown> => Array.from(data),
      {
        secret: "legacy-secret",
        async decryptLegacy(
          data: Uint8Array,
          secret: string,
        ): Promise<Uint8Array> {
          decryptCalls += 1;
          expect(data).toBe(legacyData);
          expect(secret).toBe("legacy-secret");
          return new Uint8Array([1, 2]);
        },
      },
    );

    expect(decoded).toEqual([1, 2]);
    expect(decryptCalls).toBe(1);
  });
});
