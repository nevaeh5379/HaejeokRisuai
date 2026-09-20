import { isTauriLinux } from "./platform";

export type LinuxBackgroundBlurSupport = "standard" | "kwinLegacy" | "none";

export interface LinuxWindowCapabilities {
  wayland: boolean;
  serverSideDecoration: boolean;
  backgroundBlur: LinuxBackgroundBlurSupport;
}

const EMPTY_CAPABILITIES: LinuxWindowCapabilities = {
  wayland: false,
  serverSideDecoration: false,
  backgroundBlur: "none",
};

function applyCapabilities(capabilities: LinuxWindowCapabilities): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const blur = capabilities.wayland && capabilities.backgroundBlur !== "none";

  root.classList.toggle("tauri-linux-wayland", capabilities.wayland);
  root.classList.toggle("tauri-linux-background-blur", blur);
  root.dataset.risuLinuxBlur = capabilities.backgroundBlur;
  root.dataset.risuLinuxServerDecoration = String(
    capabilities.serverSideDecoration,
  );
}

export async function initializeLinuxWindowIntegration(): Promise<LinuxWindowCapabilities> {
  if (!isTauriLinux) {
    return { ...EMPTY_CAPABILITIES };
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const capabilities = await invoke<LinuxWindowCapabilities>(
      "get_linux_window_capabilities",
    );
    applyCapabilities(capabilities);
    return capabilities;
  } catch (error) {
    applyCapabilities(EMPTY_CAPABILITIES);
    console.warn("Failed to initialize Linux Wayland integration:", error);
    return { ...EMPTY_CAPABILITIES };
  }
}
