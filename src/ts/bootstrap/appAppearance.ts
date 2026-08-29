import { updateAnimationSpeed } from "../gui/animation";
import { updateColorScheme, updateTextThemeAndCSS } from "../gui/colorscheme";
import { updateGuisize } from "../gui/guisize";
import { syncMobileGUI } from "../stores.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";

/**
 * Updates the height mode of the document based on the value stored in the
 * database.
 */
export function updateHeightMode() {
  const db = settingsStore.state;
  const root = document.querySelector(":root") as HTMLElement;
  switch (db.heightMode) {
    case "auto":
      root.style.setProperty("--risu-height-size", "100%");
      break;
    case "vh":
      root.style.setProperty("--risu-height-size", "100vh");
      break;
    case "dvh":
      root.style.setProperty("--risu-height-size", "100dvh");
      break;
    case "lvh":
      root.style.setProperty("--risu-height-size", "100lvh");
      break;
    case "svh":
      root.style.setProperty("--risu-height-size", "100svh");
      break;
    case "percent":
      root.style.setProperty("--risu-height-size", "100%");
      break;
  }
}

/**
 * Applies all persisted appearance-related settings (colorscheme, text
 * theme, animation speed, height mode, GUI size, mobile GUI layout).
 */
export function applyStartupAppearance(): void {
  updateColorScheme();
  updateTextThemeAndCSS();
  updateAnimationSpeed();
  updateHeightMode();
  updateGuisize();
  syncMobileGUI(settingsStore.state.betaMobileGUI);
}
