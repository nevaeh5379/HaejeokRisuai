import { describe, it, expect } from "vitest";
import { hasher } from "./hash";

describe("hasher unit tests", () => {
  it("computes correct SHA-256 hex string for empty data", async () => {
    const data = new Uint8Array(0);
    const hash = await hasher(data);
    expect(hash).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("computes correct SHA-256 hex string for known ascii payload", async () => {
    const data = new TextEncoder().encode("hello world");
    const hash = await hasher(data);
    expect(hash).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });

  it("computes correct SHA-256 hex string for binary bytes", async () => {
    const data = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
    const hash = await hasher(data);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
