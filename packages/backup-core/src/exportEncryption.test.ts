import { describe, expect, it } from "vitest";
import { prepareAccountBackupEncryption } from "./exportEncryption";

describe("prepareAccountBackupEncryption", (): void => {
  it("does nothing when encryption is disabled", async (): Promise<void> => {
    let requested: boolean = false;
    const key: string | undefined = await prepareAccountBackupEncryption({
      enabled: false,
      metadataEntryName: "encryption",
      requestKey: async (): Promise<string> => {
        requested = true;
        return "key";
      },
      write: async (): Promise<void> => undefined,
    });
    expect(key).toBeUndefined();
    expect(requested).toBe(false);
  });

  it("validates the key and writes streaming metadata", async (): Promise<void> => {
    const entries: Array<readonly [string, string]> = [];
    const key: string | undefined = await prepareAccountBackupEncryption({
      enabled: true,
      metadataEntryName: "encryption",
      requestKey: async (time: number): Promise<string> => `key-${time}`,
      write: async (name: string, data: Uint8Array): Promise<void> => {
        entries.push([name, new TextDecoder().decode(data)]);
      },
      databaseEncryption: "stream-v1",
      now: (): number => 42,
    });

    expect(key).toBe("key-42");
    expect(entries).toEqual([
      [
        "encryption",
        JSON.stringify({
          time: 42,
          type: "account",
          databaseEncryption: "stream-v1",
        }),
      ],
    ]);
  });

  it("rejects invalid key responses", async (): Promise<void> => {
    await expect(
      prepareAccountBackupEncryption({
        enabled: true,
        metadataEntryName: "encryption",
        requestKey: async (): Promise<unknown> => ({ key: "nested" }),
        write: async (): Promise<void> => undefined,
      }),
    ).rejects.toThrow("invalid key");
  });
});
