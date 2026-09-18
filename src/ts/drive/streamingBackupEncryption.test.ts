import { describe, expect, it } from "vitest";
import {
  decryptStreamingBackupEntry,
  encryptStreamingBackupEntry,
  isStreamingBackupEncryptedEntry,
} from "./streamingBackupEncryption";

describe("streaming backup encryption", () => {
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
});
