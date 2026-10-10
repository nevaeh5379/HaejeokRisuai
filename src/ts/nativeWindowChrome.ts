import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriMacOS, isTauriWindows } from "./platform";

export type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

export function windowDragRegion(
  node: HTMLElement,
  options: { windowsOnly?: boolean; selfOnly?: boolean } = {},
) {
  if (isTauriMacOS && !options.windowsOnly)
    node.setAttribute("data-tauri-drag-region", "true");

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
