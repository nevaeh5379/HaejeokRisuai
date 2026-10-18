import { writable } from "svelte/store";

// Shared by CharacterStore and the legacy UI bridge without importing the
// aggregate stores module back into a domain store.
export const selectedCharID = writable(-1);
