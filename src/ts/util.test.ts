import { describe, expect, it } from "vitest";
import { base64url, simplifySchema } from "./util";

describe("base64url", () => {
  it("encodes standard byte arrays into url-safe base64 without padding", () => {
    const data = new TextEncoder().encode("Hello World?+/>");
    const result = base64url(data);
    expect(result).not.toContain("+");
    expect(result).not.toContain("/");
    expect(result).not.toContain("=");
    expect(result).toBe("SGVsbG8gV29ybGQ_Ky8-");
  });

  it("accepts ArrayBuffer input", () => {
    const buffer = new TextEncoder().encode("Antigravity").buffer;
    const result = base64url(buffer);
    expect(result).toBe("QW50aWdyYXZpdHk");
  });

  it("safely handles large byte arrays without stack overflow", () => {
    // 100KB buffer would trigger RangeError: Maximum call stack size exceeded with String.fromCharCode.apply(null, [...bytes])
    const largeBuffer = new Uint8Array(100_000);
    largeBuffer.fill(42);
    expect(() => base64url(largeBuffer)).not.toThrow();
    const result = base64url(largeBuffer);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("simplifySchema", () => {
  it("normalizes array types with null to nullable flag and primary type", () => {
    const schema: Record<string, any> = {
      type: ["string", "null"],
      description: "Optional string",
    };
    const simplified = simplifySchema(schema, {});
    expect(simplified.type).toBe("string");
    expect(schema.nullable).toBe(true);
  });
});
