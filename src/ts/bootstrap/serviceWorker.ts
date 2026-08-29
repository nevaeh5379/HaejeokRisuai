import { setUsingSw } from "../globalApi.svelte";
import { isCapacitor } from "../platform";
import { LoadingStatusState } from "../stores.svelte";
import { sleep } from "../util";

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
  return !isCapacitor && navigator.serviceWorker
    ? registerSw()
        .then(() => setUsingSw(true))
        .catch(() => setUsingSw(false))
    : Promise.resolve(setUsingSw(false));
}
