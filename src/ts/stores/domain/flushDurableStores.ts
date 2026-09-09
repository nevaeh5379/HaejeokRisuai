import { characterStore } from "./characterStore.svelte";
import { messageStore } from "./messageStore.svelte";
import { moduleStore } from "./moduleStore.svelte";
import { personaStore } from "./personaStore.svelte";
import { presetStore } from "./presetStore.svelte";
import { settingsStore } from "./settingsStore.svelte";
import type { FlushableStore } from "./storeContracts";

const durableStores: readonly FlushableStore[] = [
  characterStore,
  presetStore,
  settingsStore,
  messageStore,
  personaStore,
  moduleStore,
];

export async function flushDurableStores(): Promise<void> {
  await Promise.all(durableStores.map((store) => store.flush()));
  if (durableStores.some((store) => store.hasPendingWrites())) {
    throw new Error(
      "Cannot snapshot storage while database writes are pending",
    );
  }
}
