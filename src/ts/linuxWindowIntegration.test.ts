import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("./platform", () => ({ isTauriLinux: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main" }),
}));

import {
  initializeLinuxWindowIntegration,
  isLinuxCsdActive,
  setLinuxWindowDecorationPreference,
} from "./linuxWindowIntegration";

describe("Linux window integration", () => {
  beforeEach(() => {
    invoke.mockReset();
    document.documentElement.classList.remove(
      "tauri-linux-wayland",
      "tauri-linux-background-blur",
      "tauri-linux-csd",
      "tauri-linux-ssd",
    );
    delete document.documentElement.dataset.risuLinuxBlur;
    delete document.documentElement.dataset.risuLinuxDecoration;
    delete document.documentElement.dataset.risuLinuxServerDecoration;
    document.documentElement.style.removeProperty(
      "--risu-linux-decoration-opacity",
    );
  });

  it("reads capabilities for the current window", async () => {
    invoke.mockResolvedValue({
      wayland: true,
      serverSideDecoration: true,
      backgroundBlur: "standard",
      decoration: "csd",
      decorationAlpha: null,
    });

    const capabilities = await initializeLinuxWindowIntegration();

    expect(invoke).toHaveBeenCalledWith("get_linux_window_capabilities", {
      label: "main",
    });
    expect(capabilities.backgroundBlur).toBe("standard");
    expect(isLinuxCsdActive()).toBe(true);
    expect(document.documentElement.classList).toContain(
      "tauri-linux-background-blur",
    );
    expect(document.documentElement.classList).toContain("tauri-linux-csd");
  });

  it("persists the native bootstrap preference", async () => {
    invoke.mockResolvedValue(undefined);

    await setLinuxWindowDecorationPreference("csd");

    expect(invoke).toHaveBeenCalledWith(
      "set_linux_window_decoration_preference",
      { decoration: "csd" },
    );
  });

  it("matches the Linux sidebar tint to the KDE decoration alpha", async () => {
    invoke.mockResolvedValue({
      wayland: true,
      serverSideDecoration: true,
      backgroundBlur: "kwinLegacy",
      decoration: "ssd",
      decorationAlpha: 128,
    });

    await initializeLinuxWindowIntegration();

    expect(
      document.documentElement.style.getPropertyValue(
        "--risu-linux-decoration-opacity",
      ),
    ).toBe(`${(128 / 255) * 100}%`);
  });

  it("keeps the document opaque when no blur protocol is available", async () => {
    invoke.mockResolvedValue({
      wayland: true,
      serverSideDecoration: false,
      backgroundBlur: "none",
      decoration: "csd",
      decorationAlpha: null,
    });

    await initializeLinuxWindowIntegration();

    expect(document.documentElement.classList).toContain("tauri-linux-wayland");
    expect(document.documentElement.classList).not.toContain(
      "tauri-linux-background-blur",
    );
  });
});
