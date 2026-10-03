import { describe, expect, it, vi } from "vitest";
import { tilt } from "./tilt";

describe("tilt action", () => {
  it("ignores non-mouse pointer events for mobile zero overhead", () => {
    const el = document.createElement("div");
    const action = tilt(el);

    el.dispatchEvent(
      new PointerEvent("pointermove", {
        pointerType: "touch",
        clientX: 100,
        clientY: 100,
      }),
    );

    expect(el.style.getPropertyValue("--rx")).toBe("");
    expect(el.style.getPropertyValue("--ry")).toBe("");

    action.destroy();
  });

  it("calculates 3D tilt angles on mouse move", async () => {
    const el = document.createElement("div");
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    const action = tilt(el, { max: 10 });

    el.dispatchEvent(
      new PointerEvent("pointermove", {
        pointerType: "mouse",
        clientX: 75, // right side: normX = 0.25 -> ry = 0.25 * 10 * 2 = 5deg
        clientY: 25, // top side: normY = -0.25 -> rx = 0.25 * 10 * 2 = 5deg
      }),
    );

    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(el.style.getPropertyValue("--rx")).toBe("5.00deg");
    expect(el.style.getPropertyValue("--ry")).toBe("5.00deg");

    action.destroy();
  });

  it("cleans up styles and event listeners on pointer leave and destroy", async () => {
    const el = document.createElement("div");
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    const action = tilt(el);

    el.dispatchEvent(
      new PointerEvent("pointermove", {
        pointerType: "mouse",
        clientX: 50,
        clientY: 50,
      }),
    );
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(el.style.getPropertyValue("--rx")).toBe("0.00deg");
    expect(el.style.getPropertyValue("--ry")).toBe("0.00deg");

    el.dispatchEvent(new PointerEvent("pointerleave"));

    expect(el.style.getPropertyValue("--rx")).toBe("");
    expect(el.style.getPropertyValue("--ry")).toBe("");

    action.destroy();
  });
});
