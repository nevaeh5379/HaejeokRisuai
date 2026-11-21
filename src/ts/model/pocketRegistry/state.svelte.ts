import {
  DEFAULT_POCKET_REGISTRY_BASE_URL,
  getPocketRegistryBaseUrl,
  loadActiveCompactBundle,
  parseCompactBundleToModels,
  resetPocketRegistryToBundled,
  setPocketRegistryBaseUrl,
  syncPocketRegistryFromRemote,
  type PocketRegistryProviderMeta,
  type PocketRegistrySyncMeta,
  type PocketRegistrySyncResult,
} from "./parser";
import type { LLMModel } from "../types";

export {
  DEFAULT_POCKET_REGISTRY_BASE_URL,
  getPocketRegistryBaseUrl,
  setPocketRegistryBaseUrl,
  type PocketRegistryProviderMeta,
  type PocketRegistrySyncMeta,
  type PocketRegistrySyncResult,
};

let onRegistryModelsUpdatedCallback: ((models: LLMModel[], providers: PocketRegistryProviderMeta[]) => void) | null = null;

class PocketRegistryStore {
  version = $state(0);
  syncing = $state(false);
  lastError = $state<string | null>(null);
  lastStatusMessage = $state<string | null>(null);
  meta = $state<PocketRegistrySyncMeta>({
    hash: "",
    syncedAt: null,
    source: "bundled",
    profileCount: 0,
  });
  providers = $state<PocketRegistryProviderMeta[]>([]);
  models = $state<LLMModel[]>([]);

  init(onUpdated: (models: LLMModel[], providers: PocketRegistryProviderMeta[]) => void) {
    onRegistryModelsUpdatedCallback = onUpdated;
    const { bundle, meta } = loadActiveCompactBundle();
    const parsed = parseCompactBundleToModels(bundle);
    this.meta = meta;
    this.providers = parsed.providers;
    this.models = parsed.models;
    this.version++;
    onUpdated(parsed.models, parsed.providers);
  }

  async sync(options?: { force?: boolean; baseUrl?: string }): Promise<PocketRegistrySyncResult> {
    this.syncing = true;
    this.lastError = null;
    try {
      const { bundle, result } = await syncPocketRegistryFromRemote(options);
      const parsed = parseCompactBundleToModels(bundle);
      this.meta = {
        hash: bundle.hash,
        syncedAt: Date.now(),
        source: "remote",
        profileCount: bundle.profiles.length,
      };
      this.providers = parsed.providers;
      this.models = parsed.models;
      this.lastStatusMessage = result.message;
      this.version++;
      onRegistryModelsUpdatedCallback?.(parsed.models, parsed.providers);
      return result;
    } catch (err: any) {
      const msg = err?.message || String(err);
      this.lastError = msg;
      throw err;
    } finally {
      this.syncing = false;
    }
  }

  resetToBundled() {
    const bundle = resetPocketRegistryToBundled();
    const parsed = parseCompactBundleToModels(bundle);
    this.meta = {
      hash: bundle.hash,
      syncedAt: null,
      source: "bundled",
      profileCount: bundle.profiles.length,
    };
    this.providers = parsed.providers;
    this.models = parsed.models;
    this.lastError = null;
    this.lastStatusMessage = `기본 내장 스냅샷으로 복원되었습니다 (${bundle.profiles.length}개 모델 프로필).`;
    this.version++;
    onRegistryModelsUpdatedCallback?.(parsed.models, parsed.providers);
  }
}

export const pocketRegistryStore = new PocketRegistryStore();
