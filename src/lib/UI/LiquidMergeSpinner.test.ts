import { afterEach, describe, expect, it } from "vitest";
import { mount, unmount } from "svelte";
import LiquidMergeSpinner from "src/lib/UI/LiquidMergeSpinner.svelte";

/** Mounted component handle kept for cleanup in afterEach. */
let mounted:
  | { app: Record<string, any>; target: HTMLElement }
  | undefined;

function mountSpinner(props: Record<string, unknown> = {}) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const app = mount(LiquidMergeSpinner, { target, props });
  mounted = { app, target };
  return mounted;
}

function liquidColor(): string {
  const root = mounted!.target.querySelector(
    ".liquid-spinner",
  ) as HTMLElement;
  return root.style.getPropertyValue("--liquid-color").toLowerCase();
}

afterEach(() => {
  if (mounted) {
    unmount(mounted.app);
    mounted.target.remove();
    mounted = undefined;
  }
});

describe("LiquidMergeSpinner", () => {
  it("renders the liquid rotor with two drops and neck", () => {
    mountSpinner();
    expect(mounted!.target.querySelector(".liquid-rotor")).not.toBeNull();
    expect(mounted!.target.querySelectorAll(".liquid-drop").length).toBe(3); // a, b, neck
  });

  it("embeds a unique SVG gooey filter per instance", () => {
    mountSpinner();
    mountSpinner();
    const filters = document.querySelectorAll("filter[id^='liquid-goo-']");
    // Both instances must reference distinct filter ids (document-global ids).
    const ids = new Set(Array.from(filters).map((f) => f.id));
    expect(ids.size).toBeGreaterThanOrEqual(2);
  });

  it("applies size prop via CSS variable", () => {
    mountSpinner({ size: 48 });
    const root = mounted!.target.querySelector(
      ".liquid-spinner",
    ) as HTMLElement;
    expect(
      root.style.getPropertyValue("--liquid-spinner-size"),
    ).toContain("48");
  });

  it("scales the 140px inner box with a unitless transform factor", () => {
    mountSpinner({ size: 20 });
    const scaleBox = mounted!.target.querySelector(
      ".liquid-scale",
    ) as HTMLElement;
    // 20 / 140 = 0.1429 — must be unitless, not "0.1429px" (which invalidates
    // the whole transform and leaves the 140px box unscaled, the bug where
    // the drops look gigantic inside a tiny container).
    expect(scaleBox.style.transform).toBe("scale(0.1429)");
  });

  // Stage colors must mirror the legacy .chat-process-stage-{1..4} / .autoload
  // colors in DefaultChatScreen.svelte exactly.
  it.each([
    { stage: 0, expected: "--risu-theme-borderc" }, // fallback: theme default
    { stage: 1, expected: "60a5fa" }, // blue
    { stage: 2, expected: "db2777" }, // pink
    { stage: 3, expected: "34d399" }, // green
    { stage: 4, expected: "8b5cf6" }, // purple
  ])("stage $stage colors the liquid $expected", ({ stage, expected }) => {
    mountSpinner({ size: 20, stage });
    expect(liquidColor()).toContain(expected.replace("#", ""));
  });

  it("applies autoload green color when autoMode is true", () => {
    mountSpinner({ size: 20, autoMode: true });
    expect(liquidColor()).toContain("10b981");
  });
});