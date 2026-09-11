import { writable } from "svelte/store";
import type { StorageProfile } from "./storageProfile";

export type StorageProfileGateState =
  | { status: "idle" }
  | {
      status: "failure";
      profile: Extract<StorageProfile, { mode: "remote" }>;
      error: string;
    };

export const storageProfileGate = writable<StorageProfileGateState>({
  status: "idle",
});

export function describeStorageStartupError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
