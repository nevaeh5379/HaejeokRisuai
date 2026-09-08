import "./ts/polyfill";
import "katex/dist/katex.min.css";
import App from "./App.svelte";
import { preLoadCheck } from "./preload";
import { mount } from "svelte";
import { Buffer } from "node:buffer";
import { isTauriMacOS } from "./ts/platform";

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

preLoadCheck();
let app = mount(App, {
  target: document.getElementById("app"),
});
void Promise.all([import("./ts/bootstrap"), import("./ts/hotkey")]).then(
  ([{ loadData }, { initHotkey }]) => {
    initHotkey();
    return loadData();
  },
);
document.getElementById("preloading").remove();

export default app;
