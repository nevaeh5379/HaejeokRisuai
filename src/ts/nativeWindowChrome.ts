import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { isTauriLinux, isTauriMacOS, isTauriWindows } from "./platform";
import {
  getActiveLinuxWindowCapabilities,
  isLinuxCsdActive,
} from "./linuxWindowIntegration";

export type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

let macosSidebarBlurUpdate = Promise.resolve();

export function applyMacOSNativeSidebarBlur(enabled: boolean): Promise<void> {
  if (!isTauriMacOS) return Promise.resolve();
  // Preserve toggle order even if an earlier native update is still pending.
  // Its caller reports errors; a failed update must not block future choices.
  macosSidebarBlurUpdate = macosSidebarBlurUpdate
    .catch(() => {})
    .then(() => invoke<void>("set_macos_native_sidebar_blur", { enabled }));
  return macosSidebarBlurUpdate;
}

export function applyMacOSSidebarTransparency(
  enabled: boolean,
  opacity: number,
): void {
  if (!isTauriMacOS || typeof document === "undefined") return;

  const clamped = Math.min(100, Math.max(0, Math.round(opacity)));
  const effectiveOpacity = enabled ? clamped : 100;
  document.documentElement.classList.toggle(
    "tauri-macos-sidebar-opaque",
    !enabled || clamped >= 100,
  );
  document.documentElement.style.setProperty(
    "--risu-macos-sidebar-opacity",
    `${effectiveOpacity}%`,
  );
}

export function installMacOSHeaderDrag() {
  if (!isTauriMacOS) return;
  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || event.defaultPrevented) return;
    const headerHeight =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--risu-macos-titlebar-height",
        ),
      ) || 28;
    // Native traffic lights occupy the leading 80px of the titlebar.
    if (
      event.clientY < 0 ||
      event.clientY >= headerHeight ||
      event.clientX < 80 ||
      event.clientX >= window.innerWidth
    )
      return;

    // Tauri handles explicitly marked targets itself. Its attribute handler
    // does not handle unmarked children, so only exclude the actual target.
    if (
      event.target instanceof Element &&
      event.target.hasAttribute("data-tauri-drag-region")
    )
      return;
    const interactive =
      'button, a, input, textarea, select, label, summary, [contenteditable], [draggable="true"], [role="button"], [role="tab"], [role="slider"], [role="menuitem"], [role="separator"], [role="checkbox"], [role="switch"], [tabindex]:not([tabindex="-1"])';
    if (
      event
        .composedPath()
        .some((node) => node instanceof Element && node.matches(interactive))
    )
      return;

    event.preventDefault();
    const currentWindow = getCurrentWindow();
    void (
      event.detail === 2
        ? currentWindow.toggleMaximize()
        : currentWindow.startDragging()
    ).catch((error) => {
      console.warn(
        "[nativeWindowChrome] Failed to handle macOS header drag",
        error,
      );
    });
  };
  document.addEventListener("mousedown", onMouseDown);
  return () => document.removeEventListener("mousedown", onMouseDown);
}

export function installLinuxCsdHeaderDrag() {
  if (!isTauriLinux) return;
  const onMouseDown = (event: MouseEvent) => {
    if (!isLinuxCsdActive() || event.button !== 0 || event.defaultPrevented)
      return;
    const height = getActiveLinuxWindowCapabilities().csdHeader?.height ?? 40;
    // Leave the native resize gutter and every interactive web control alone.
    if (
      event.clientY < 6 ||
      event.clientY >= height ||
      event.clientX < 6 ||
      event.clientX >= window.innerWidth - 6
    )
      return;
    const interactive =
      'button, a, input, textarea, select, label, summary, [contenteditable], [draggable="true"], [role="button"], [role="tab"], [role="slider"], [role="menuitem"], [data-tauri-drag-region]';
    if (
      event
        .composedPath()
        .some(
          (node) => node instanceof HTMLElement && node.matches(interactive),
        )
    )
      return;
    event.preventDefault();
    const currentWindow = getCurrentWindow();
    void (
      event.detail === 2
        ? currentWindow.toggleMaximize()
        : currentWindow.startDragging()
    ).catch((error) => {
      console.warn(
        "[nativeWindowChrome] Failed to handle CSD header drag",
        error,
      );
    });
  };
  document.addEventListener("mousedown", onMouseDown);
  return () => document.removeEventListener("mousedown", onMouseDown);
}

export function windowDragRegion(
  node: HTMLElement,
  options: { windowsOnly?: boolean; selfOnly?: boolean } = {},
) {
  const updateDragRegion = () => {
    if (
      !options.windowsOnly &&
      (isTauriMacOS || (isTauriLinux && isLinuxCsdActive()))
    )
      node.setAttribute("data-tauri-drag-region", "true");
    else node.removeAttribute("data-tauri-drag-region");
  };
  updateDragRegion();
  if (isTauriLinux)
    window.addEventListener("risu-linux-csd-header-layout", updateDragRegion);

  const onPointerDown = (event: PointerEvent) => {
    if (!isTauriWindows || event.button !== 0 || !event.isPrimary) return;
    if (options.selfOnly && event.target !== node) return;
    event.preventDefault();
    void getCurrentWindow()
      .startDragging()
      .catch((error) => {
        console.warn("[nativeWindowChrome] Failed to start window drag", error);
      });
  };

  if (isTauriWindows) node.addEventListener("pointerdown", onPointerDown);
  return {
    destroy() {
      window.removeEventListener(
        "risu-linux-csd-header-layout",
        updateDragRegion,
      );
      node.removeAttribute("data-tauri-drag-region");
      node.removeEventListener("pointerdown", onPointerDown);
    },
  };
}

export function startWindowResize(
  direction: ResizeDirection,
  event: PointerEvent,
) {
  if (!isTauriWindows || event.button !== 0 || !event.isPrimary) return;
  event.preventDefault();
  void getCurrentWindow()
    .startResizeDragging(direction)
    .catch((error) => {
      console.warn(`[nativeWindowChrome] Failed to resize ${direction}`, error);
    });
}
