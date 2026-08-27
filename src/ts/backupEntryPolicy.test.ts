import { describe, expect, it } from "vitest";
import { classifyBackupEntry } from "@risuai/backup-core/entryPolicy.cjs";

describe("backup entry policy", () => {
  it("keeps core entries and supported asset layouts", () => {
    expect(classifyBackupEntry("database.risudat").kind).toBe("database");
    expect(classifyBackupEntry("encryption.risudat").kind).toBe("encryption");
    expect(classifyBackupEntry("avatar.png").kind).toBe("asset");
    expect(classifyBackupEntry("assets/avatar.png").kind).toBe("asset");
    expect(classifyBackupEntry("assets/folder/avatar.png").kind).toBe("asset");
  });

  it("keeps both cold-storage naming variants", () => {
    expect(classifyBackupEntry(
      "coldstorage/11111111-1111-1111-1111-111111111111.json",
    ).kind).toBe("coldStorage");
    expect(classifyBackupEntry(
      "coldstorage_22222222-2222-2222-2222-222222222222.json",
    ).kind).toBe("coldStorage");
  });

  it("treats unknown fork namespaces as optional extensions", () => {
    for (const name of [
      "inlay/abc.png",
      "inlay_sidecar/abc",
      "inlay_meta/abc",
      "other-fork/cache/item.bin",
    ]) {
      expect(classifyBackupEntry(name).kind).toBe("extension");
    }
  });

  it("rejects malformed or traversal paths", () => {
    expect(classifyBackupEntry("../escape.bin").kind).toBe("invalid");
    expect(classifyBackupEntry("fork//item.bin").kind).toBe("invalid");
    expect(classifyBackupEntry("/absolute.bin").kind).toBe("invalid");
  });
});
