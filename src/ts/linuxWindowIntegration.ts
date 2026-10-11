import { isTauriLinux } from "./platform";

export type LinuxWindowDecoration = "ssd" | "csd";
export type LinuxBackgroundBlurSupport = "standard" | "kwinLegacy" | "none";

export interface LinuxCsdHeaderLayout {
  height: number;
  left: number;
  right: number;
}

export interface LinuxWindowCapabilities {
  wayland: boolean;
  serverSideDecoration: boolean;
  backgroundBlur: LinuxBackgroundBlurSupport;
  decoration: LinuxWindowDecoration;
  decorationAlpha: number | null;
  csdHeader: LinuxCsdHeaderLayout | null;
}

const EMPTY_CAPABILITIES: LinuxWindowCapabilities = {
  wayland: false,
  serverSideDecoration: false,
  backgroundBlur: "none",
  decoration: "ssd",
  decorationAlpha: null,
  csdHeader: null,
};

let activeCapabilities: LinuxWindowCapabilities = { ...EMPTY_CAPABILITIES };
const CSD_LAYOUT_EVENT = "risu-linux-csd-header-layout";

export function getActiveLinuxWindowCapabilities(): LinuxWindowCapabilities {
  return { ...activeCapabilities };
}

export function getActiveLinuxWindowDecoration(): LinuxWindowDecoration {
  return activeCapabilities.decoration;
}

export function isLinuxCsdActive(): boolean {
  return (
    isTauriLinux &&
    activeCapabilities.wayland &&
    activeCapabilities.decoration === "csd"
  );
}

export async function setLinuxWindowDecorationPreference(
  decoration: LinuxWindowDecoration,
): Promise<void> {
  if (!isTauriLinux) return;

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_linux_window_decoration_preference", { decoration });
}

export function applyLinuxDecorationAlpha(alpha: number | null): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  if (alpha == null) {
    root.style.removeProperty("--risu-linux-decoration-opacity");
    return;
  }

  const clamped = Math.min(255, Math.max(0, alpha));
  root.style.setProperty(
    "--risu-linux-decoration-opacity",
    `${(clamped / 255) * 100}%`,
  );
}

export function applyLinuxCsdSidebarOpacity(opacity: number): void {
  document.documentElement.style.setProperty(
    "--risu-linux-csd-sidebar-opacity",
    `${Math.min(100, Math.max(0, opacity))}%`,
  );
}

function applyCapabilities(capabilities: LinuxWindowCapabilities): void {
  activeCapabilities = capabilities;
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  const blur = capabilities.wayland && capabilities.backgroundBlur !== "none";
  const csd = capabilities.wayland && capabilities.decoration === "csd";

  root.classList.toggle("tauri-linux-wayland", capabilities.wayland);
  root.classList.toggle("tauri-linux-background-blur", blur);
  root.classList.toggle("tauri-linux-csd", csd);
  root.classList.toggle(
    "tauri-linux-ssd",
    capabilities.wayland && capabilities.decoration === "ssd",
  );
  applyLinuxDecorationAlpha(capabilities.decorationAlpha);
  root.dataset.risuLinuxBlur = capabilities.backgroundBlur;
  root.dataset.risuLinuxDecoration = capabilities.decoration;
  root.dataset.risuLinuxServerDecoration = String(
    capabilities.serverSideDecoration,
  );
  applyCsdHeaderLayout(capabilities.csdHeader);
}

function applyCsdHeaderLayout(layout: LinuxCsdHeaderLayout | null): void {
  activeCapabilities.csdHeader = layout;
  document.documentElement.style.setProperty(
    "--risu-linux-csd-titlebar-height",
    `${layout?.height ?? 40}px`,
  );
  document.documentElement.style.setProperty(
    "--risu-linux-csd-sidebar-top-inset",
    `${layout && layout.left > 0 ? layout.height : 0}px`,
  );
  window.dispatchEvent(new Event(CSD_LAYOUT_EVENT));
}

// Reserve native controls only where this tab strip actually meets a window
// edge. Split panes and an open sidebar can move it away from those controls.
export function linuxCsdTabInsets(node: HTMLElement) {
  if (!isTauriLinux) return;
  const update = () => {
    const layout = activeCapabilities.csdHeader;
    const bounds = node.getBoundingClientRect();
    const atTop = isLinuxCsdActive() && bounds.top < (layout?.height ?? 40);
    const left = atTop ? Math.max(0, (layout?.left ?? 0) - bounds.left) : 0;
    const right = atTop
      ? Math.max(0, bounds.right - (window.innerWidth - (layout?.right ?? 0)))
      : 0;
    node.style.setProperty("--risu-linux-csd-left-inset", `${left}px`);
    node.style.setProperty("--risu-linux-csd-right-inset", `${right}px`);
  };
  const observer = new ResizeObserver(update);
  observer.observe(node);
  window.addEventListener(CSD_LAYOUT_EVENT, update);
  window.addEventListener("resize", update);
  update();
  return {
    destroy() {
      observer.disconnect();
      window.removeEventListener(CSD_LAYOUT_EVENT, update);
      window.removeEventListener("resize", update);
    },
  };
}

export async function initializeLinuxWindowIntegration(): Promise<LinuxWindowCapabilities> {
  if (!isTauriLinux) {
    return { ...EMPTY_CAPABILITIES };
  }

  try {
    const [{ invoke }, { getCurrentWebviewWindow }] = await Promise.all([
      import("@tauri-apps/api/core"),
      import("@tauri-apps/api/webviewWindow"),
    ]);
    const currentWindow = getCurrentWebviewWindow();
    const label = currentWindow.label;
    await currentWindow.listen<LinuxCsdHeaderLayout>(
      "linux-csd-header-layout",
      ({ payload }) => applyCsdHeaderLayout(payload),
    );
    const capabilities = await invoke<LinuxWindowCapabilities>(
      "get_linux_window_capabilities",
      { label },
    );
    applyCapabilities(capabilities);
    return capabilities;
  } catch (error) {
    applyCapabilities(EMPTY_CAPABILITIES);
    console.warn("Failed to initialize Linux Wayland integration:", error);
    return { ...EMPTY_CAPABILITIES };
  }
}
