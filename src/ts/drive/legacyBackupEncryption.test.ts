import { describe, expect, it, vi } from "vitest";
import {
  decryptLegacyAccountBackup,
  fetchLegacyBackupKey,
} from "./legacyBackupEncryption";

describe("legacy backup encryption", () => {
  it("returns a validated key from the upstream service", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ key: "secret-key" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    await expect(fetchLegacyBackupKey(1234, fetchImpl)).resolves.toBe(
      "secret-key",
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://sv.risuai.xyz/cryptokey?key=1234",
    );
  });

  it("decrypts only after a valid key is received", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ key: "secret-key" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const decrypt = vi.fn(async () => new Uint8Array([9, 8, 7]).buffer);

    await expect(
      decryptLegacyAccountBackup(new Uint8Array([1]), 1234, decrypt, fetchImpl),
    ).resolves.toEqual(new Uint8Array([9, 8, 7]));
    expect(decrypt).toHaveBeenCalledWith(new Uint8Array([1]), "secret-key");
  });

  it("rejects a failed key request before decryption", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
    ) as unknown as typeof fetch;
    const decrypt = vi.fn(async () => new ArrayBuffer(0));

    await expect(
      decryptLegacyAccountBackup(
        new Uint8Array([1, 2, 3]),
        1234,
        decrypt,
        fetchImpl,
      ),
    ).rejects.toThrow("Legacy backup key request failed (403 Forbidden)");
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("rejects key responses without a usable key", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ key: null }), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(fetchLegacyBackupKey(1234, fetchImpl)).rejects.toThrow(
      "Legacy backup key response did not contain a valid key",
    );
  });
});
