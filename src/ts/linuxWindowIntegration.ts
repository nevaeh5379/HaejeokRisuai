import { isTauriLinux } from "./platform";

export type LinuxWindowDecoration = "ssd" | "csd";
export type LinuxBackgroundBlurSupport = "standard" | "kwinLegacy" | "none";

export interface LinuxWindowCapabilities {
  wayland: boolean;
  serverSideDecoration: boolean;
  backgroundBlur: LinuxBackgroundBlurSupport;
  decoration: LinuxWindowDecoration;
}

const EMPTY_CAPABILITIES: LinuxWindowCapabilities = {
  wayland: false,
  serverSideDecoration: false,
  backgroundBlur: "none",
  decoration: "ssd",
};

let activeCapabilities: LinuxWindowCapabilities = { ...EMPTY_CAPABILITIES };

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
  root.dataset.risuLinuxBlur = capabilities.backgroundBlur;
  root.dataset.risuLinuxDecoration = capabilities.decoration;
  root.dataset.risuLinuxServerDecoration = String(
    capabilities.serverSideDecoration,
  );
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
    const label = getCurrentWebviewWindow().label;
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
