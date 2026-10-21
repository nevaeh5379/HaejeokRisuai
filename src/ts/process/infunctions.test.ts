import { describe, expect, it } from "vitest";
import { calcString } from "./infunctions";

describe("infunctions calcString RPN evaluation", () => {
  it("evaluates simple arithmetic", () => {
    expect(calcString("2 + 3")).toBe(5);
    expect(calcString("10 - 4")).toBe(6);
    expect(calcString("3 * 4")).toBe(12);
    expect(calcString("15 / 3")).toBe(5);
    expect(calcString("2 ^ 3")).toBe(8);
    expect(calcString("10 % 3")).toBe(1);
  });

  it("handles operator precedence and parentheses", () => {
    expect(calcString("2 + 3 * 4")).toBe(14);
    expect(calcString("(2 + 3) * 4")).toBe(20);
    expect(calcString("((2 + 3) * 2) + 5")).toBe(15);
  });

  it("handles logical and comparison operators", () => {
    expect(calcString("5 > 3")).toBe(1);
    expect(calcString("5 < 3")).toBe(0);
    expect(calcString("5 >= 5")).toBe(1);
    expect(calcString("4 <= 5")).toBe(1);
    expect(calcString("5 == 5")).toBe(1);
    expect(calcString("5 != 4")).toBe(1);
    expect(calcString("1 && 0")).toBe(0);
    expect(calcString("1 || 0")).toBe(1);
    expect(calcString("!0")).toBe(1);
    expect(calcString("!1")).toBe(0);
  });

  it("handles negative numbers", () => {
    expect(calcString("-5 + 10")).toBe(5);
    expect(calcString("10 + -5")).toBe(5);
    expect(calcString("(-5) * 2")).toBe(-10);
  });
});
