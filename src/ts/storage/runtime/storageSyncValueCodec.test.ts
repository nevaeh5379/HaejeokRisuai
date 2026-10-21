import { describe, expect, it } from "vitest";
import {
  STORAGE_SYNC_OBJECT_TAG,
  STORAGE_SYNC_SPECIAL_TAG,
  decodeStorageSyncValue,
  encodeStorageSyncValue,
} from "@risuai/protocol/storageSyncValueCodec.ts";

function roundTrip<T>(value: T): T {
  return decodeStorageSyncValue(
    JSON.parse(JSON.stringify(encodeStorageSyncValue(value))),
  ) as T;
}

describe("storage sync value codec", () => {
  it("preserves JSON values without wrapping ordinary objects", () => {
    const value = { text: "hello\0world", nested: [true, null, 3.5] };
    expect(encodeStorageSyncValue(value)).toEqual(value);
    expect(roundTrip(value)).toEqual(value);
  });

  it("preserves undefined and non-finite numbers at arbitrary depth", () => {
    const value = {
      missing: undefined,
      values: [undefined, NaN, Infinity, -Infinity, -0],
    };
    const decoded = roundTrip(value);
    expect(Object.prototype.hasOwnProperty.call(decoded, "missing")).toBe(true);
    expect(decoded.missing).toBeUndefined();
    expect(decoded.values[0]).toBeUndefined();
    expect(Number.isNaN(decoded.values[1])).toBe(true);
    expect(decoded.values[2]).toBe(Infinity);
    expect(decoded.values[3]).toBe(-Infinity);
    expect(Object.is(decoded.values[4], -0)).toBe(true);
  });

  it("escapes reserved object keys without collisions", () => {
    const value = {
      [STORAGE_SYNC_SPECIAL_TAG]: "user value",
      [STORAGE_SYNC_OBJECT_TAG]: { nested: undefined },
      __proto__: null,
    } as Record<string, unknown>;
    const decoded = roundTrip(value);
    expect(decoded[STORAGE_SYNC_SPECIAL_TAG]).toBe("user value");
    expect(decoded[STORAGE_SYNC_OBJECT_TAG]).toEqual({ nested: undefined });
  });

  it("preserves dangerous property names as data properties", () => {
    const value: Record<string, unknown> = {};
    Object.defineProperty(value, "__proto__", {
      value: { polluted: true },
      enumerable: true,
    });
    const decoded = roundTrip(value);
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(decoded, "__proto__")).toBe(
      true,
    );
    expect(decoded.__proto__).toEqual({ polluted: true });
    expect(({} as any).polluted).toBeUndefined();
  });

  it("returns original reference when no encoding or decoding transformations are needed", () => {
    const ordinary = { a: 1, b: "hello", c: true, d: null };
    expect(encodeStorageSyncValue(ordinary)).toBe(ordinary);
    expect(decodeStorageSyncValue(ordinary)).toBe(ordinary);
  });

  it("roundtrips complex nested objects containing mixed normal and special values", () => {
    const complex = {
      user: { name: "Risu", score: 100, active: true },
      data: [1, 2, NaN, { flag: undefined, inf: Infinity }],
      empty: {},
    };
    const decoded = roundTrip(complex);
    expect(decoded.user).toEqual({ name: "Risu", score: 100, active: true });
    expect(decoded.data[0]).toBe(1);
    expect(decoded.data[1]).toBe(2);
    expect(Number.isNaN(decoded.data[2] as number)).toBe(true);
    const innerObj = decoded.data[3] as { flag: unknown; inf: number };
    expect(innerObj.flag).toBeUndefined();
    expect(innerObj.inf).toBe(Infinity);
    expect(decoded.empty).toEqual({});
  });
});
