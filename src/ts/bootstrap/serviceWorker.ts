import { setUsingSw } from "../globalApi.svelte";
import { isCapacitor, isTauri } from "../platform";
import { LoadingStatusState } from "../stores.svelte";
import { waitForCompatibleServiceWorkerController } from "./serviceWorkerProtocol";

let swMessageHandlerInstalled = false;

async function unregisterTauriServiceWorker(): Promise<void> {
  if (!navigator.serviceWorker) return;

  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    await registration?.unregister();
  } catch {
    // Tauri does not use the web service worker. Cleanup failure must never
    // block native startup or trigger the web reload recovery path.
  }
}

function installServiceWorkerMessageHandler(): void {
  if (swMessageHandlerInstalled || !navigator.serviceWorker) return;
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data;
    if (data?.type !== "OPEN_CHAT" || typeof data.chatId !== "string") return;
    void import("../chatTabs.svelte")
      .then(({ findChatTarget, openChatTargetInTab }) => {
        const target =
          typeof data.characterId === "string"
            ? { characterId: data.characterId, chatId: data.chatId }
            : findChatTarget(data.chatId);
        if (target) {
          return openChatTargetInTab(target.characterId, target.chatId);
        }
      })
      .catch(() => {});
  });
  swMessageHandlerInstalled = true;
}

/**
 * Registers the service worker and initializes it.
 */
async function registerSw(): Promise<boolean> {
  const reg = await navigator.serviceWorker.register("/sw.js", {
    scope: "/",
  });
  try {
    await reg.update();
  } catch {}
  if (!(await waitForCompatibleServiceWorkerController())) {
    location.reload();
    return false;
  }
  return true;
}

/**
 * Starts tracking the service worker (web only) and reports its
 * availability through `setUsingSw`. Resolves once registration settled;
 * never rejects.
 */
export function startServiceWorker(): Promise<void> {
  LoadingStatusState.text = "Checking Service Worker...";

  if (isTauri) {
    setUsingSw(false);
    return unregisterTauriServiceWorker();
  }

  if (!isCapacitor && navigator.serviceWorker) {
    installServiceWorkerMessageHandler();
    return registerSw()
      .then((available) => setUsingSw(available))
      .catch(() => setUsingSw(false));
  }
  return Promise.resolve(setUsingSw(false));
}
