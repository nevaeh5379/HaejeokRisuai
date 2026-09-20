import { describe, expect, it, vi } from "vitest";
import { classifyBackupEntry } from "./entryPolicy";
import {
  dispatchBackupRestoreEntry,
  type AccountBackupEncryptionMetadata,
  type BackupRestoreEntryHandlers,
} from "./restoreEntry";

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function handlers(): BackupRestoreEntryHandlers {
  return {
    onEncryption: vi.fn(),
    onDatabase: vi.fn(),
    onDatabaseStream: vi.fn(),
    onInlay: vi.fn(),
    onColdStorage: vi.fn(),
    onAsset: vi.fn(),
  };
}

describe("dispatchBackupRestoreEntry", (): void => {
  it("validates and dispatches account encryption metadata", async (): Promise<void> => {
    const callbacks: BackupRestoreEntryHandlers = handlers();
    const data: Uint8Array = bytes('{"type":"account","time":123}');

    await dispatchBackupRestoreEntry(
      "encryption.risudat",
      data,
      classifyBackupEntry("encryption.risudat"),
      callbacks,
    );

    const expected: AccountBackupEncryptionMetadata = {
      type: "account",
      time: 123,
    };
    expect(callbacks.onEncryption).toHaveBeenCalledWith(expected);
  });

  it("reports malformed encryption metadata and rejects it", async (): Promise<void> => {
    const parseErrors: unknown[] = [];
    const callbacks: BackupRestoreEntryHandlers = {
      ...handlers(),
      onEncryptionParseError(error: unknown): void {
        parseErrors.push(error);
      },
    };

    await expect(
      dispatchBackupRestoreEntry(
        "encryption.risudat",
        bytes("{"),
        classifyBackupEntry("encryption.risudat"),
        callbacks,
      ),
    ).rejects.toThrow("encryption metadata is invalid");
    expect(parseErrors).toHaveLength(1);
  });

  it("rejects incomplete account encryption metadata", async (): Promise<void> => {
    const callbacks: BackupRestoreEntryHandlers = handlers();

    await expect(
      dispatchBackupRestoreEntry(
        "encryption.risudat",
        bytes('{"type":"account","time":0}'),
        classifyBackupEntry("encryption.risudat"),
        callbacks,
      ),
    ).rejects.toThrow("encryption metadata is incomplete");
    expect(callbacks.onEncryption).not.toHaveBeenCalled();
  });

  it("routes database, stream, inlay, and asset entries", async (): Promise<void> => {
    const callbacks: BackupRestoreEntryHandlers = handlers();
    const data: Uint8Array = new Uint8Array([1, 2, 3]);
    const entries: string[] = [
      "database.risudat",
      "database.stream/000000000001.risudat",
      "inlay_00000000-0000-0000-0000-000000000001.risuinlay",
      "assets/icon.png",
    ];
    for (const name of entries) {
      await dispatchBackupRestoreEntry(
        name,
        data,
        classifyBackupEntry(name),
        callbacks,
      );
    }

    expect(callbacks.onDatabase).toHaveBeenCalledWith(data);
    expect(callbacks.onDatabaseStream).toHaveBeenCalledWith(
      "database.stream/000000000001.risudat",
      data,
    );
    expect(callbacks.onInlay).toHaveBeenCalledWith(
      "00000000-0000-0000-0000-000000000001",
      data,
    );
    expect(callbacks.onAsset).toHaveBeenCalledWith("assets/icon.png", data);
  });

  it("keeps invalid cold-storage payloads out of asset fallback", async (): Promise<void> => {
    const invalidEntries: string[] = [];
    const callbacks: BackupRestoreEntryHandlers = {
      ...handlers(),
      onInvalidColdStorage(_key: string, name: string): void {
        invalidEntries.push(name);
      },
    };
    const name: string =
      "coldstorage_00000000-0000-0000-0000-000000000001.json";

    await dispatchBackupRestoreEntry(
      name,
      bytes("{}"),
      classifyBackupEntry(name),
      callbacks,
    );

    expect(invalidEntries).toEqual([name]);
    expect(callbacks.onColdStorage).not.toHaveBeenCalled();
    expect(callbacks.onAsset).not.toHaveBeenCalled();
  });

  it("decodes and dispatches valid cold-storage payloads", async (): Promise<void> => {
    const callbacks: BackupRestoreEntryHandlers = handlers();
    const name: string =
      "coldstorage_00000000-0000-0000-0000-000000000001.json";

    await dispatchBackupRestoreEntry(
      name,
      bytes('{"character":{"name":"Airisu"}}'),
      classifyBackupEntry(name),
      callbacks,
    );

    expect(callbacks.onColdStorage).toHaveBeenCalledWith(
      "00000000-0000-0000-0000-000000000001",
      { character: { name: "Airisu" } },
      name,
    );
    expect(callbacks.onAsset).not.toHaveBeenCalled();
  });

  it("reports cold-storage JSON parse errors without aborting", async (): Promise<void> => {
    const parseErrors: unknown[] = [];
    const callbacks: BackupRestoreEntryHandlers = {
      ...handlers(),
      onColdStorageParseError(
        _key: string,
        _name: string,
        error: unknown,
      ): void {
        parseErrors.push(error);
      },
    };
    const name: string =
      "coldstorage_00000000-0000-0000-0000-000000000001.json";

    await expect(
      dispatchBackupRestoreEntry(
        name,
        bytes("{"),
        classifyBackupEntry(name),
        callbacks,
      ),
    ).resolves.toBeUndefined();
    expect(parseErrors).toHaveLength(1);
    expect(callbacks.onColdStorage).not.toHaveBeenCalled();
  });
});
