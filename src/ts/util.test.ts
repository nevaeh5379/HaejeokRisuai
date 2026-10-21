import { describe, expect, it } from "vitest";
import { BufferToText, base64url, simplifySchema } from "./util";

describe("util functions", () => {
  it("base64url encodes ArrayBuffer and Uint8Array without stack overflow", () => {
    const raw = new Uint8Array([1, 2, 3, 250, 255]);
    const encoded = base64url(raw);
    expect(encoded).toBe("AQID-v8");

    // Also test with ArrayBuffer
    const encodedBuffer = base64url(raw.buffer);
    expect(encodedBuffer).toBe("AQID-v8");

    // Large payload that would exceed call-stack limit if using String.fromCharCode.apply
    const large = new Uint8Array(70000);
    large.fill(65); // 'A'
    const largeEncoded = base64url(large);
    expect(largeEncoded.length).toBeGreaterThan(0);
    expect(largeEncoded).not.toContain("+");
    expect(largeEncoded).not.toContain("/");
    expect(largeEncoded).not.toContain("=");
  });

  it("BufferToText decodes UTF-8 bytes using shared decoder", () => {
    const text = "안녕하세요 RisuAI";
    const bytes = new TextEncoder().encode(text);
    expect(BufferToText(bytes)).toBe(text);
  });

  it("simplifySchema handles array type without filter[0]", () => {
    const schema = {
      type: ["string", "null"],
    };
    const simplified = simplifySchema(schema);
    expect(simplified.type).toBe("string");
  });
});
