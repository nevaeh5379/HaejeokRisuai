import { get } from "svelte/store";
import {
  MobileGUI,
  MobileSideBar,
  sideBarClosing,
  sideBarStore,
} from "../stores.svelte";

class BtwRuntimeStore {
  open = $state(false);
  characterIndex = $state(-1);
  chatIndex = $state(-1);
  generating = $state<Record<string, boolean>>({});
  errors = $state<Record<string, string>>({});
}

export const btwRuntime = new BtwRuntimeStore();

export function showBtwSidebar(characterIndex: number, chatIndex: number) {
  btwRuntime.characterIndex = characterIndex;
  btwRuntime.chatIndex = chatIndex;
  btwRuntime.open = true;

  if (get(MobileGUI)) {
    MobileSideBar.set(4);
    return;
  }

  sideBarClosing.set(false);
  sideBarStore.set(true);
}

export function closeBtwSidebar() {
  btwRuntime.open = false;
  MobileSideBar.update((value) => (value === 4 ? 0 : value));
}
