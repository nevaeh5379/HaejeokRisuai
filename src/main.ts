import "./ts/polyfill";
import "katex/dist/katex.min.css";
import { preLoadCheck } from "./preload";
import { mount } from "svelte";
import { Buffer } from "node:buffer";
import { isTauriMacOS } from "./ts/platform";
import {
  parseTauriSidebarMenuLaunch,
  readTauriSidebarMenuPopupPayload,
} from "./ts/tauriSidebarMenu";

if (typeof window !== "undefined") {
  window.Buffer = Buffer;
  if (isTauriMacOS) {
    document.documentElement.classList.add("tauri-macos-vibrancy");
  }
}

window.addEventListener("vite:preloadError", (event) => {
  console.error("Chunk load error detected:", event);
  alert(
    "The server has been updated or the network connection has been lost. Please refresh the page.",
  );
});

async function start() {
  const sidebarMenuLaunch = isTauriMacOS
    ? parseTauriSidebarMenuLaunch(location.search)
    : null;
  if (sidebarMenuLaunch) {
    document.documentElement.classList.add("tauri-sidebar-menu-popup");
    document.getElementById("preloading")?.remove();
    const payload = readTauriSidebarMenuPopupPayload(
      sidebarMenuLaunch.popupWindowLabel,
    );
    if (!payload) {
      const { getCurrentWebviewWindow } =
        await import("@tauri-apps/api/webviewWindow");
      await getCurrentWebviewWindow().close();
      return null;
    }
    const { default: SidebarMenuPopup } =
      await import("./lib/SideBars/SidebarMenuPopup.svelte");
    return mount(SidebarMenuPopup, {
      target: document.getElementById("app"),
      props: { launch: sidebarMenuLaunch, payload },
    });
  }

  const { default: App } = await import("./App.svelte");
  preLoadCheck();
  const app = mount(App, {
    target: document.getElementById("app"),
  });
  void Promise.all([import("./ts/bootstrap"), import("./ts/hotkey")]).then(
    ([{ loadData }, { initHotkey }]) => {
      initHotkey();
      return loadData();
    },
  );
  document.getElementById("preloading")?.remove();
  return app;
}

const app = start();
export default app;
