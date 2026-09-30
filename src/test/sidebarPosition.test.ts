import { describe, expect, it } from "vitest";
import { computeSidebarLayoutOrder } from "../ts/gui/sidebarPosition";

describe("computeSidebarLayoutOrder", () => {
  it("computes default order when both are on the left", () => {
    const order = computeSidebarLayoutOrder(false, false, false);
    expect(order).toEqual({
      botListOrder: 1,
      sidebarPanelOrder: 2,
      mainContentOrder: 3,
    });
  });

  it("computes inverted order when both are on the left", () => {
    const order = computeSidebarLayoutOrder(false, false, true);
    expect(order).toEqual({
      sidebarPanelOrder: 1,
      botListOrder: 2,
      mainContentOrder: 3,
    });
  });

  it("computes order when both are on the right (bot list outer, sidebar inner)", () => {
    const order = computeSidebarLayoutOrder(true, true, false);
    expect(order).toEqual({
      mainContentOrder: 1,
      sidebarPanelOrder: 2,
      botListOrder: 3,
    });
  });

  it("computes inverted order when both are on the right (sidebar outer, bot list inner)", () => {
    const order = computeSidebarLayoutOrder(true, true, true);
    expect(order).toEqual({
      mainContentOrder: 1,
      botListOrder: 2,
      sidebarPanelOrder: 3,
    });
  });

  it("computes separated order: sidebar left, bot list right", () => {
    const order = computeSidebarLayoutOrder(false, true, false);
    expect(order).toEqual({
      sidebarPanelOrder: 1,
      mainContentOrder: 2,
      botListOrder: 3,
    });
  });

  it("computes separated order: bot list left, sidebar right", () => {
    const order = computeSidebarLayoutOrder(true, false, false);
    expect(order).toEqual({
      botListOrder: 1,
      mainContentOrder: 2,
      sidebarPanelOrder: 3,
    });
  });
});
