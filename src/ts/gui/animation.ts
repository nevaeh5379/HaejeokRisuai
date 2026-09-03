import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";

export function updateAnimationSpeed() {
  const db = settingsStore.state;
  document.documentElement.style.setProperty(
    "--risu-animation-speed",
    db.animationSpeed + "s",
  );
}
