import { describe, expect, it } from "vitest";
import {
  STREAMING_BACKUP_ENCRYPTION_FORMAT,
  decryptStreamingBackupEntry,
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
});
