import { setUsingSw } from "../globalApi.svelte";
import { isCapacitor } from "../platform";
import { LoadingStatusState } from "../stores.svelte";
import { waitForCompatibleServiceWorkerController } from "./serviceWorkerProtocol";

let swMessageHandlerInstalled = false;

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
  if (!isCapacitor && navigator.serviceWorker) {
    installServiceWorkerMessageHandler();
    return registerSw()
      .then((available) => setUsingSw(available))
      .catch(() => setUsingSw(false));
  }
  return Promise.resolve(setUsingSw(false));
}
