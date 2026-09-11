import type { StorageProfile } from "./storageProfile";
import {
  NodeApiClient,
  createSameOriginNodeApiClient,
} from "@risuai/storage-remote/nodeApiClient";

export * from "@risuai/storage-remote/nodeApiClient";

export async function createRemoteNodeApiClient(
  profile: Extract<StorageProfile, { mode: "remote" }>,
  platform: "web" | "tauri" | "capacitor" | "node",
): Promise<NodeApiClient> {
  if (platform === "tauri") {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return new NodeApiClient(
      profile,
      (input, init) => tauriFetch(input, init) as Promise<Response>,
    );
  }
  if (platform === "node" && profile.baseUrl === globalThis.location?.origin) {
    return createSameOriginNodeApiClient();
  }
  // CapacitorHttp patches window.fetch/XMLHttpRequest when enabled in
  // capacitor.config.ts. Web clients intentionally use the browser transport
  // so mixed-content and certificate failures remain visible to the user.
  return new NodeApiClient(profile);
}
