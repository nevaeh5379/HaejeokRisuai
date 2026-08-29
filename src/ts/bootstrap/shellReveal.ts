import { loadedStore, startupPhase } from "../stores.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";

/**
 * Controls the single transition from the startup screen to the app shell.
 * In lowSpecMode the reveal is deferred until the runtime settings finished
 * hydrating, so the startup screen stays visible during heavy work.
 *
 * Returns the `revealShell` callback; calling it more than once is a no-op.
 */
export function createShellRevealer(): () => void {
  const deferShellUntilRuntimeReady = settingsStore.state.lowSpecMode === true;
  let shellReady = false;
  const revealShell = () => {
    if (shellReady) return;
    shellReady = true;
    loadedStore.set(true);
    startupPhase.set("shell-ready");
    performance.mark("shell-ready");
  };
  if (!deferShellUntilRuntimeReady) {
    revealShell();
  }
  return revealShell;
}
