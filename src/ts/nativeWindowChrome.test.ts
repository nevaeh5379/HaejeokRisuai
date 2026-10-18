import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { platform, startDragging, toggleMaximize, invoke } = vi.hoisted(() => ({
  platform: { isTauriMacOS: true, isTauriLinux: false, isTauriWindows: false },
  startDragging: vi.fn().mockResolvedValue(undefined),
  toggleMaximize: vi.fn().mockResolvedValue(undefined),
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

vi.mock("./platform", () => platform);
vi.mock("./linuxWindowIntegration", () => ({
  isLinuxCsdActive: () => false,
  getActiveLinuxWindowCapabilities: () => ({}),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging, toggleMaximize }),
}));

import {
  applyMacOSNativeSidebarBlur,
  installMacOSHeaderDrag,
} from "./nativeWindowChrome";

describe("macOS sidebar material switching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.isTauriMacOS = true;
  });

  it("preserves rapid toggle order while a native update is pending", async () => {
    let complete!: () => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const first = applyMacOSNativeSidebarBlur(true);
    const second = applyMacOSNativeSidebarBlur(false);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenLastCalledWith("set_macos_native_sidebar_blur", {
      enabled: true,
    });
    complete();
    await Promise.all([first, second]);
    expect(invoke).toHaveBeenLastCalledWith("set_macos_native_sidebar_blur", {
      enabled: false,
    });
  });

  it("reports failure and allows the next choice to proceed", async () => {
    invoke.mockRejectedValueOnce(new Error("native material unavailable"));
    await expect(applyMacOSNativeSidebarBlur(true)).rejects.toThrow(
      "native material unavailable",
    );
    await applyMacOSNativeSidebarBlur(false);
    expect(invoke).toHaveBeenLastCalledWith("set_macos_native_sidebar_blur", {
      enabled: false,
    });
  });

  it("does not invoke native commands on other platforms", async () => {
    platform.isTauriMacOS = false;
    await applyMacOSNativeSidebarBlur(true);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("macOS window header dragging", () => {
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    platform.isTauriMacOS = true;
    document.body.innerHTML = "<div id='header'><span>Title</span></div>";
    document.documentElement.style.setProperty(
      "--risu-macos-titlebar-height",
      "28px",
    );
    cleanup = installMacOSHeaderDrag();
  });

  afterEach(() => {
    cleanup?.();
    document.body.innerHTML = "";
    document.documentElement.style.removeProperty(
      "--risu-macos-titlebar-height",
    );
  });

  function press(node: Element, options: MouseEventInit = {}) {
    const event = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      clientX: 160,
      clientY: 16,
      detail: 1,
      ...options,
    });
    node.dispatchEvent(event);
    return event;
  }

  it("moves the window from an unmarked header descendant", () => {
    const event = press(document.querySelector("span")!);
    expect(startDragging).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("handles descendants of native drag regions without double handling their target", () => {
    const header = document.querySelector("#header")!;
    header.setAttribute("data-tauri-drag-region", "true");
    press(header);
    expect(startDragging).not.toHaveBeenCalled();
    press(header.querySelector("span")!);
    expect(startDragging).toHaveBeenCalledOnce();
  });

  it("maximizes on a double click", () => {
    press(document.querySelector("span")!, { detail: 2 });
    expect(toggleMaximize).toHaveBeenCalledOnce();
    expect(startDragging).not.toHaveBeenCalled();
  });

  it.each([
    "button",
    "input",
    "textarea",
    "select",
    "a",
    "[role=tab]",
    "[role=separator]",
    "[contenteditable]",
  ])("preserves interaction with %s in the header", (selector) => {
    document.body.innerHTML = `<button><svg><path /></svg></button><input><textarea></textarea><select></select><a></a><div role="tab"><span></span></div><div role="separator"></div><div contenteditable="true"></div>`;
    const element = document.querySelector(selector)!;
    const event = press(element.querySelector("path, span") ?? element);
    expect(startDragging).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it.each([
    { clientY: 28 },
    { clientY: 150 },
    { clientY: -1 },
    { clientX: 40 },
    { button: 2 },
  ])("ignores content, traffic lights, and secondary clicks: %j", (options) => {
    press(document.querySelector("span")!, options);
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("respects prevented events and removes its listener on teardown", () => {
    const target = document.querySelector("span")!;
    target.addEventListener("mousedown", (event) => event.preventDefault(), {
      once: true,
    });
    press(target);
    expect(startDragging).not.toHaveBeenCalled();
    cleanup?.();
    press(target);
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("does not install on other platforms", () => {
    cleanup?.();
    platform.isTauriMacOS = false;
    cleanup = installMacOSHeaderDrag();
    press(document.querySelector("span")!);
    expect(startDragging).not.toHaveBeenCalled();
  });
});
