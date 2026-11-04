import { describe, it, expect } from "vitest";
import {
  canUseText,
  encodeJsonValue,
  decodeJsonValue,
  encodeScript,
  decodeScript,
} from "./jsonCodec";

describe("jsonCodec", () => {
  it("canUseText accurately validates UTF-8 strings without null bytes", () => {
    expect(canUseText("simple ASCII")).toBe(true);
    expect(canUseText("한글 및 다국어 텍스트")).toBe(true);
    expect(canUseText("emoji 🌸✨")).toBe(true);
    expect(canUseText("null\0byte")).toBe(false);
    expect(canUseText(String.fromCharCode(0xd800))).toBe(false);
    expect(canUseText(String.fromCharCode(0xdc00))).toBe(false);
    expect(canUseText(123)).toBe(false);
    expect(canUseText(null)).toBe(false);
  });

  it("encodeJsonValue and decodeJsonValue round-trip normal objects without mutating", () => {
    const input = {
      name: "Ojosama",
      age: 18,
      items: ["fan", "tea", "rose"],
      nested: {
        score: 100,
        active: true,
      },
    };

    const encoded = encodeJsonValue(input);
    expect(encoded).toBe(input); // Copy-on-write returns original reference when no encoding is needed

    const decoded = decodeJsonValue(encoded);
    expect(decoded).toBe(input); // Copy-on-write returns original reference
  });

  it("encodes and decodes strings with null characters safely", () => {
    const objWithNull = {
      clean: "regular text",
      poisoned: "text with \0 null byte",
    };

    const encoded = encodeJsonValue(objWithNull) as Record<string, unknown>;
    expect(encoded).not.toBe(objWithNull);
    expect(typeof encoded.clean).toBe("string");
    expect(typeof encoded.poisoned).toBe("object");

    const decoded = decodeJsonValue(encoded) as Record<string, unknown>;
    expect(decoded.clean).toBe("regular text");
    expect(decoded.poisoned).toBe("text with \0 null byte");
  });

  it("handles script encoding and decoding with UTF-16 fallback", () => {
    const regularScript = "console.log('clean script');";
    expect(encodeScript(regularScript)).toBe(regularScript);
    expect(decodeScript(regularScript)).toBe(regularScript);

    const scriptWithNull = "const x = '\0';";
    const encodedScript = encodeScript(scriptWithNull) as string;
    expect(
      encodedScript.startsWith("__risu_pg_script_utf16le_v1_8e81b0b9__:"),
    ).toBe(true);
    expect(decodeScript(encodedScript)).toBe(scriptWithNull);
  });
});
