// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  defaultCBSRegisterArg,
  registerCBS,
  type RegisterCallback,
} from "./cbs";

describe("CBS min and max functions", () => {
  const callbacks = new Map<string, RegisterCallback>();

  registerCBS({
    ...defaultCBSRegisterArg,
    registerFunction: ({ name, alias, callback }) => {
      if (callback === "doc_only") return;
      callbacks.set(name, callback);
      for (const item of alias) callbacks.set(item, callback);
    },
    parseArray: (str: string) => {
      try {
        return JSON.parse(str);
      } catch {
        return [];
      }
    },
  });

  const dummyMatcherArg: any = {
    cbsConditions: {},
    db: {} as any,
    chara: {} as any,
    chatID: 0,
    rmVar: false,
  };

  it("calculates min with variable arguments", () => {
    const minCb = callbacks.get("min");
    expect(minCb).toBeDefined();
    const result = minCb!("", dummyMatcherArg, ["5", "2", "8"], {});
    expect(result).toBe("2");
  });

  it("calculates max with variable arguments", () => {
    const maxCb = callbacks.get("max");
    expect(maxCb).toBeDefined();
    const result = maxCb!("", dummyMatcherArg, ["5", "2", "8"], {});
    expect(result).toBe("8");
  });

  it("handles non-numeric values as 0", () => {
    const minCb = callbacks.get("min")!;
    const maxCb = callbacks.get("max")!;
    expect(minCb("", dummyMatcherArg, ["foo", "10"], {})).toBe("0");
    expect(maxCb("", dummyMatcherArg, ["foo", "-10"], {})).toBe("0");
  });

  it("handles parsed array string as single argument", () => {
    const minCb = callbacks.get("min")!;
    const maxCb = callbacks.get("max")!;
    expect(minCb("", dummyMatcherArg, [JSON.stringify([12, 3, 45])], {})).toBe(
      "3",
    );
    expect(maxCb("", dummyMatcherArg, [JSON.stringify([12, 3, 45])], {})).toBe(
      "45",
    );
  });

  it("calculates min and max over large arrays (> 65536 items) without RangeError call stack overflow", () => {
    const minCb = callbacks.get("min")!;
    const maxCb = callbacks.get("max")!;
    const largeCount = 80_000;
    const largeArray = new Array<number>(largeCount);
    for (let i = 0; i < largeCount; i++) {
      largeArray[i] = i + 10;
    }
    largeArray[500] = -42;
    largeArray[75000] = 999_999;

    const minResult = minCb(
      "",
      dummyMatcherArg,
      [JSON.stringify(largeArray)],
      {},
    );
    expect(minResult).toBe("-42");

    const maxResult = maxCb(
      "",
      dummyMatcherArg,
      [JSON.stringify(largeArray)],
      {},
    );
    expect(maxResult).toBe("999999");
  });
});
