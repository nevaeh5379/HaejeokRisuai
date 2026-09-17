import { get } from "svelte/store";
import type { AndroidNativeEntry } from "./androidNativeIntegration";
import { queueAndroidComposerPrefill } from "./androidNativeEntryState";
import {
  loadedStore,
  MobileSideBar,
  settingsOpen,
} from "./stores.svelte";
import { characterStore } from "./stores/domain";
import { changeChar } from "./characters";
import { findChatTarget } from "./chatTabs.svelte";

async function waitForAppData(): Promise<void> {
  if (get(loadedStore)) return;
  await new Promise<void>((resolve) => {
    let unsubscribe = () => {};
    unsubscribe = loadedStore.subscribe((loaded) => {
      if (!loaded) return;
      unsubscribe();
      resolve();
    });
  });
}

function resolveTarget(entry: AndroidNativeEntry): {
  characterId?: string;
  chatId?: string;
} {
  if (entry.characterId) {
    return { characterId: entry.characterId, chatId: entry.chatId };
  }
  if (!entry.chatId) return {};
  const target = findChatTarget(entry.chatId);
  return target
    ? { characterId: target.characterId, chatId: target.chatId }
    : { chatId: entry.chatId };
}
async function openTarget(
  characterId?: string,
  chatId?: string,
): Promise<boolean> {
  if (!characterId) return false;
  const characterIndex = characterStore.characters.findIndex(
    (character) => character.chaId === characterId,
  );
  if (characterIndex < 0) return false;

  await changeChar(characterIndex, chatId ? { chatId } : {});
  settingsOpen.set(false);
  MobileSideBar.set(0);
  return true;
}

function queueSharedText(
  entry: AndroidNativeEntry,
  characterId?: string,
  chatId?: string,
): void {
  const text = entry.text?.trim();
  if (!text) return;
  queueAndroidComposerPrefill({
    text,
    characterId,
    chatId,
  });
}

export async function routeAndroidNativeEntry(
  entry: AndroidNativeEntry,
): Promise<void> {
  await waitForAppData();
  const target = resolveTarget(entry);

  if (entry.type === "open-chat") {
    await openTarget(target.characterId, target.chatId);
    return;
  }

  if (entry.type === "open-character" || entry.type === "new-chat") {
    await openTarget(target.characterId);
    return;
  }

  if (entry.type === "share-text" || entry.type === "process-text") {
    if (target.characterId) {
      await openTarget(target.characterId, target.chatId);
    }
    queueSharedText(entry, target.characterId, target.chatId);
  }
}
