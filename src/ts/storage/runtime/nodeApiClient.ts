import type { StorageProfile } from "./storageProfile";
import {
  NodeApiClient,
  type NodeApiFetch,
  createSameOriginNodeApiClient,
} from "@risuai/storage-remote/nodeApiClient";

export * from "@risuai/storage-remote/nodeApiClient";

type StreamedNativeFetch = (
  url: string,
  options: {
    body?: string | Uint8Array | ArrayBuffer;
    headers?: Record<string, string>;
    method?: "POST" | "GET" | "PUT" | "DELETE" | "PATCH";
    signal?: AbortSignal;
    logFetch?: boolean;
  },
) => Promise<Response>;

/**
 * Adapts the fetch-shaped Node API client to the chunked native transport.
 * CapacitorHttp returns JSON through one bridge message, which is unreliable
 * for real-world module documents containing large CBS/HTML/CSS payloads.
 */
export function createCapacitorNodeApiFetch(
  streamedFetch: StreamedNativeFetch,
): NodeApiFetch {
  return async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (!isStreamedNativeMethod(method)) {
      throw new TypeError(`Unsupported native Node API method: ${method}`);
    }
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    let body: Uint8Array | undefined;

    if (init?.body != null) {
      body = new Uint8Array(await new Response(init.body).arrayBuffer());
    } else if (method !== "GET" && method !== "DELETE") {
      // fetchNative requires a body for native mutation methods even when the
      // HTTP endpoint intentionally has no payload (for example job creation
      // and finalize actions). Preserve fetch semantics with a zero-byte body.
      body = new Uint8Array();
    }

    return streamedFetch(input, {
      body,
      headers,
      method,
      signal: init?.signal ?? undefined,
      logFetch: false,
    });
  };
}

function isStreamedNativeMethod(
  method: string,
): method is "POST" | "GET" | "PUT" | "DELETE" | "PATCH" {
  return ["POST", "GET", "PUT", "DELETE", "PATCH"].includes(method);
}

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
  if (platform === "capacitor") {
    const { fetchNative } = await import("../../globalApi.svelte");
    return new NodeApiClient(profile, createCapacitorNodeApiFetch(fetchNative));
  }
  if (platform === "node" && profile.baseUrl === globalThis.location?.origin) {
    return createSameOriginNodeApiClient();
  }
  // Web clients intentionally use the browser transport so mixed-content and
  // certificate failures remain visible to the user.
  return new NodeApiClient(profile);
}
