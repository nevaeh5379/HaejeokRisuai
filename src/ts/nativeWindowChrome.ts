import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriMacOS, isTauriWindows } from "./platform";
import { isLinuxCsdActive } from "./linuxWindowIntegration";

export type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      "button, a, input, textarea, select, [role='button'], [data-no-window-drag]",
    ),
  );
}

function startDragging(event: PointerEvent): void {
  if (
    event.button !== 0 ||
    !event.isPrimary ||
    isInteractiveTarget(event.target)
  ) {
    return;
  }
  event.preventDefault();
  void getCurrentWindow()
    .startDragging()
    .catch((error) => {
      console.warn("[nativeWindowChrome] Failed to start window drag", error);
    });
}

export function windowDragRegion(node: HTMLElement) {
  const linuxCsd = isLinuxCsdActive();
  if (isTauriMacOS) node.setAttribute("data-tauri-drag-region", "true");

  const onPointerDown = (event: PointerEvent) => {
    if (!isTauriWindows && !linuxCsd) return;
    startDragging(event);
  };
  const onDoubleClick = (event: MouseEvent) => {
    if (!linuxCsd || isInteractiveTarget(event.target)) return;
    void getCurrentWindow()
      .toggleMaximize()
      .catch((error) => {
        console.warn("[nativeWindowChrome] Failed to toggle maximize", error);
      });
  };

  if (isTauriWindows || linuxCsd) {
    node.addEventListener("pointerdown", onPointerDown);
  }
  if (linuxCsd) {
    node.addEventListener("dblclick", onDoubleClick);
  }

  return {
    destroy() {
      node.removeAttribute("data-tauri-drag-region");
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("dblclick", onDoubleClick);
    },
  };
}

export function linuxCsdWindowDragRegion(node: HTMLElement) {
  if (!isLinuxCsdActive()) return {};

  const onPointerDown = (event: PointerEvent) => startDragging(event);
  const onDoubleClick = (event: MouseEvent) => {
    if (isInteractiveTarget(event.target)) return;
    void getCurrentWindow()
      .toggleMaximize()
      .catch((error) => {
        console.warn("[nativeWindowChrome] Failed to toggle maximize", error);
      });
  };

  node.addEventListener("pointerdown", onPointerDown);
  node.addEventListener("dblclick", onDoubleClick);

  return {
    destroy() {
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("dblclick", onDoubleClick);
    },
  };
}

export function startWindowResize(
  direction: ResizeDirection,
  event: PointerEvent,
) {
  if (
    (!isTauriWindows && !isLinuxCsdActive()) ||
    event.button !== 0 ||
    !event.isPrimary
  ) {
    return;
  }
  event.preventDefault();
  void getCurrentWindow()
    .startResizeDragging(direction)
    .catch((error) => {
      console.warn(`[nativeWindowChrome] Failed to resize ${direction}`, error);
    });
}
