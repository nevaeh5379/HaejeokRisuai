export const SERVICE_WORKER_PROTOCOL_VERSION = "v3";

/**
 * Verifies that this page is controlled by a service worker that supports the
 * streaming download endpoint. A normal 200 response is insufficient because
 * hosts commonly serve the HTML app shell for unknown paths.
 */
export async function hasCompatibleServiceWorkerController(): Promise<boolean> {
  if (
    typeof navigator === "undefined" ||
    !navigator.serviceWorker?.controller
  ) {
    return false;
  }

  try {
    const response = await fetch("/sw/init", { cache: "no-store" });
    if (!response.ok) return false;
    return (await response.text()).trim() === SERVICE_WORKER_PROTOCOL_VERSION;
  } catch {
    return false;
  }
}

export async function waitForCompatibleServiceWorkerController(
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await hasCompatibleServiceWorkerController()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);

  return hasCompatibleServiceWorkerController();
}
