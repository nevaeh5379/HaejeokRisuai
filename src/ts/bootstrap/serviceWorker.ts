import { setUsingSw } from "../globalApi.svelte";
import { isCapacitor } from "../platform";
import { LoadingStatusState } from "../stores.svelte";
import { sleep } from "../util";

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
async function registerSw() {
  const reg = await navigator.serviceWorker.register("/sw.js", {
    scope: "/",
  });
  try {
    await reg.update();
  } catch {}
  await sleep(100);
  const da = await fetch("/sw/init");
  if (!(da.status >= 200 && da.status < 300)) {
    location.reload();
  }
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
      .then(() => setUsingSw(true))
      .catch(() => setUsingSw(false));
  }
  return Promise.resolve(setUsingSw(false));
}
