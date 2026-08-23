import { isWeb } from "./ts/platform";

export function preLoadCheck() {
  const searchParams = new URLSearchParams(location.search);

  // Check if the user has visited the main page
  if (!isWeb) {
    localStorage.setItem("mainpage", "visited");
  } else if (searchParams.has("mainpage")) {
    localStorage.setItem("mainpage", searchParams.get("mainpage"));
  }

  if (typeof window !== "undefined") {
    const flushStores = () => {
      void import("./ts/stores/domain/settingsStore.svelte").then(
        ({ settingsStore }) => settingsStore.flush(),
      );
      void import("./ts/stores/domain/characterStore.svelte").then(
        ({ characterStore }) => characterStore.flush(),
      );
    };
    window.addEventListener("pagehide", flushStores);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flushStores();
      }
    });
    if (isWeb) {
      //Add beforeunload event listener to prevent the user from leaving the page and flush stores
      window.addEventListener("beforeunload", (e) => {
        flushStores();
        e.preventDefault();
        //legacy browser
        e.returnValue = true;
      });
    }
  }

  return true;
}
