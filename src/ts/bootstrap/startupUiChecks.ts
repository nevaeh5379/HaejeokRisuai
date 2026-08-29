import { alertError, alertMd, waitAlert } from "../alert";
import { language } from "../../lang";

/**
 * Updates the error handling by adding custom handlers for errors and
 * unhandled promise rejections.
 */
export function updateErrorHandling() {
  const errorHandler = (event: ErrorEvent) => {
    console.error(event.error);
    if (event.error && !(event.error.target instanceof Worker)) {
      alertError(event.error);
    }
  };
  const rejectHandler = (event: PromiseRejectionEvent) => {
    console.error(event.reason);
    alertError(event.reason);
  };
  window.addEventListener("error", errorHandler);
  window.addEventListener("unhandledrejection", rejectHandler);
}

/**
 * Shows the nightly-build disclaimer the first time on
 * nightly.risuai.xyz and never again afterwards.
 */
export async function warnNightlyIfNeeded(): Promise<void> {
  if (
    localStorage.getItem("nightlyWarned") ||
    window.location.hostname !== "nightly.risuai.xyz"
  ) {
    return;
  }
  alertMd(language.nightlyWarning);
  await waitAlert();
  //for testing, leave empty
  localStorage.setItem("nightlyWarned", "");
}

/**
 * Asks the browser to persist storage when the app runs as an installed
 * PWA (standalone display mode).
 */
export async function persistStorageIfStandalone(): Promise<void> {
  try {
    const standaloneNavigator = window.navigator as Navigator & {
      standalone?: boolean;
    };
    const isInStandaloneMode =
      window.matchMedia("(display-mode: standalone)").matches ||
      standaloneNavigator.standalone === true ||
      document.referrer.includes("android-app://");
    if (isInStandaloneMode) {
      await navigator.storage.persist();
    }
  } catch (error) {}
}
