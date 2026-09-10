import { describe, expect, it } from "vitest";
import {
  decodePluginStorageRecord,
  decodePluginStorageValue,
  encodePluginStorageValue,
} from "./pluginStorageValueCodec";

describe("plugin storage SQL value codec", () => {
  it("preserves nested NUL-containing strings without emitting NUL JSON", () => {
    const value = {
      summary: "before\0after",
      nested: ["ordinary", { "key\0name": "value\0text" }],
    };

    const encoded = encodePluginStorageValue(value);

    expect(JSON.stringify(encoded)).not.toContain("\\u0000");
    expect(decodePluginStorageValue(encoded)).toEqual(value);
  });

  it("preserves unpaired UTF-16 surrogates", () => {
    const value = { high: "before\ud800after", low: "before\udcffafter" };

    const encoded = encodePluginStorageValue(value);

    expect(decodePluginStorageValue(encoded)).toEqual(value);
  });

  it("leaves ordinary JSON values unchanged", () => {
    const value = { text: "평범한 기억 🧠", count: 3 };

    expect(encodePluginStorageValue(value)).toBe(value);
  });

  it("decodes each encoded record value while retaining legacy values", () => {
    const ordinary = { text: "legacy" };
    const decoded = decodePluginStorageRecord({
      ordinary,
      encoded: encodePluginStorageValue("a\0b"),
    });

    expect(decoded).toEqual({ ordinary, encoded: "a\0b" });
  });
});
