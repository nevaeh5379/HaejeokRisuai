import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("./platform", () => ({ isTauriLinux: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { initializeLinuxWindowIntegration } from "./linuxWindowIntegration";

describe("initializeLinuxWindowIntegration", () => {
  beforeEach(() => {
    invoke.mockReset();
    document.documentElement.classList.remove(
      "tauri-linux-wayland",
      "tauri-linux-background-blur",
    );
    delete document.documentElement.dataset.risuLinuxBlur;
    delete document.documentElement.dataset.risuLinuxServerDecoration;
  });

  it("enables compositor material only when blur is supported", async () => {
    invoke.mockResolvedValue({
      wayland: true,
      serverSideDecoration: true,
      backgroundBlur: "standard",
    });

    const capabilities = await initializeLinuxWindowIntegration();

    expect(capabilities.backgroundBlur).toBe("standard");
    expect(document.documentElement.classList).toContain(
      "tauri-linux-background-blur",
    );
    expect(document.documentElement.dataset.risuLinuxServerDecoration).toBe(
      "true",
    );
  });

  it("keeps the document opaque when no blur protocol is available", async () => {
    invoke.mockResolvedValue({
      wayland: true,
      serverSideDecoration: false,
      backgroundBlur: "none",
    });

    await initializeLinuxWindowIntegration();

    expect(document.documentElement.classList).toContain("tauri-linux-wayland");
    expect(document.documentElement.classList).not.toContain(
      "tauri-linux-background-blur",
    );
  });
});
