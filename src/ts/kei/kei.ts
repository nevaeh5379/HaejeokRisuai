import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { hubURL } from "../characterCards";


export function keiServerURL() {
  const db = settingsStore.state;
  if (db.keiServerURL) return db.keiServerURL;
  return hubURL + "/kei";
}
