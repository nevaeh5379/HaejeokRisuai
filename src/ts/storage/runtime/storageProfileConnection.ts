import { isCapacitor, isNodeServer, isTauri } from "../../platform";
import { NodeStorage } from "../files/nodeStorage";
import { createRemoteNodeApiClient } from "./nodeApiClient";
import type { NodeApiClient } from "@risuai/storage-remote/nodeApiClient";
import {
  normalizeRemoteBaseUrl,
  type StorageProfile,
  type StorageProfilePlatform,
} from "./storageProfile";

export function getCurrentStorageProfilePlatform(): StorageProfilePlatform {
  if (isNodeServer) return "node";
  if (isTauri) return "tauri";
  if (isCapacitor) return "capacitor";
  return "web";
}

export async function connectRemoteStorageProfile(options: {
  baseUrl: string;
  allowInsecureHttp: boolean;
  password: string;
  pageProtocol?: string;
}): Promise<{
  profile: Extract<StorageProfile, { mode: "remote" }>;
  apiClient: NodeApiClient;
  storage: NodeStorage;
}> {
  const platform = getCurrentStorageProfilePlatform();
  const profile = {
    version: 1 as const,
    mode: "remote" as const,
    baseUrl: normalizeRemoteBaseUrl(options.baseUrl, {
      allowInsecureHttp: options.allowInsecureHttp,
      platform,
      pageProtocol: options.pageProtocol ?? globalThis.location?.protocol,
    }),
    allowInsecureHttp: options.allowInsecureHttp,
  };
  const apiClient = await createRemoteNodeApiClient(profile, platform);
  const storage = new NodeStorage(apiClient);
  await storage.connectWithPassword(options.password);
  return { profile, apiClient, storage };
}
