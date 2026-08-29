import { v4 as uuidv4 } from "uuid";
import type { botPreset } from "../../storage/database/schema";
import { presetTemplate } from "../../storage/presets/presetDefaults";
import type {
  BotPresetSummary,
  ISqlStorage,
  StoredBotPreset,
} from "../../storage/sql/ISqlStorage";
import { safeStructuredClone } from "../../polyfill";
import { commitSqlChanges } from "../../storage/sql/sqlCommitCoordinator";
import { BoundedCache } from "../../memory/boundedCache";
import type { InitializableStore } from "./storeContracts";

export type PresetLoadStatus = "idle" | "loading" | "ready" | "error";

/**
 * Fully hydrated presets are large documents. The cache is bounded so
 * browsing or backing up many presets cannot accumulate them all in memory;
 * the active preset and its neighbours are the ones worth keeping warm.
 */
const PRESET_CACHE_MAX_ENTRIES = 6;

class PresetStore implements InitializableStore<[storage: ISqlStorage]> {
  private storage: ISqlStorage | null = null;
  private activePresetProvider: (() => StoredBotPreset | undefined) | null =
    null;
  summaries = $state<BotPresetSummary[]>([]);
  activeId = $state("");
  private presetCache = new BoundedCache<string, StoredBotPreset>({
    maxEntries: PRESET_CACHE_MAX_ENTRIES,
  });
  listStatus = $state<PresetLoadStatus>("idle");
  activeStatus = $state<PresetLoadStatus>("idle");
  error = $state<string | null>(null);

  /** Map-compatible read view so external consumers keep working. */
  get cache(): Map<string, StoredBotPreset> {
    return this.presetCache as unknown as Map<string, StoredBotPreset>;
  }

  get list(): botPreset[] {
    return this.summaries.map(
      (summary) =>
        this.cache.get(summary.id) ??
        ({
          id: summary.id,
          name: summary.name,
          image: summary.image,
          apiType: summary.apiType,
          aiModel: summary.aiModel,
        } as unknown as StoredBotPreset),
    );
  }
  get activeIndex(): number {
    const index = this.summaries.findIndex(
      (preset) => preset.id === this.activeId,
    );
    return index < 0 ? 0 : index;
  }
  get activePreset(): StoredBotPreset | undefined {
    return this.activePresetProvider?.() ?? this.cache.get(this.activeId);
  }

  /**
   * Makes the live SettingsStore configuration the canonical active preset.
   * Only inactive preset documents remain cached after this boundary is bound.
   */
  bindActivePresetProvider(
    provider: () => StoredBotPreset | undefined,
  ): void {
    this.activePresetProvider = provider;
    this.cache.delete(this.activeId);
  }

  get activePresetMetadata(): BotPresetSummary | undefined {
    return this.summaries.find((preset) => preset.id === this.activeId);
  }

  async init(storage: ISqlStorage): Promise<void> {
    this.storage = storage;
    this.listStatus = "loading";
    this.activeStatus = "loading";
    this.error = null;
    try {
      const [initialSummaries, storedActiveId] = await Promise.all([
        storage.listBotPresets(),
        storage.loadSettingKey("activeBotPresetId"),
      ]);
      let summaries = initialSummaries;
      const preferredActiveId =
        typeof storedActiveId === "string" ? storedActiveId : undefined;
      if (summaries.length === 0) {
        const id = uuidv4();
        const data = safeStructuredClone(presetTemplate);
        data.name = "Default";
        await commitSqlChanges(storage, {
          baseRevision: storage.getRevision(),
          action: "preset:create-default",
          root: { upserts: [], deletes: [] },
          presets: {
            upserts: [{ id, position: 0, data }],
            deletes: [],
            order: [id],
            activeId: id,
          },
          characters: [],
          chats: [],
          chatManifests: [],
          messages: [],
          messageManifests: [],
        });
        summaries = await storage.listBotPresets();
      }
      this.summaries = summaries;
      this.listStatus = "ready";
      const activeId = summaries.some(
        (summary) => summary.id === preferredActiveId,
      )
        ? preferredActiveId!
        : summaries[0].id;
      await this.setActiveId(activeId, preferredActiveId !== activeId);
    } catch (error) {
      this.listStatus = "error";
      this.activeStatus = "error";
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async load(id: string, force = false): Promise<StoredBotPreset> {
    if (!this.storage) throw new Error("Preset store is not initialized");
    if (id === this.activeId && this.activePresetProvider) {
      const active = this.activePresetProvider();
      if (active) return active;
    }
    if (!force && this.cache.has(id)) return this.cache.get(id)!;
    const preset = await this.storage.loadBotPreset(id);
    if (!preset) throw new Error(`Preset not found: ${id}`);
    this.cache.set(id, preset);
    return preset;
  }
  async retryActive(): Promise<void> {
    if (!this.activeId) return;
    this.activeStatus = "loading";
    this.error = null;
    try {
      await this.load(this.activeId, true);
      this.activeStatus = "ready";
    } catch (error) {
      this.activeStatus = "error";
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
  async savePreset(preset: botPreset, position?: number): Promise<void> {
    if (!this.storage) throw new Error("Preset store is not initialized");
    const id =
      (preset as StoredBotPreset).id ||
      this.summaries[position ?? this.activeIndex]?.id ||
      uuidv4();
    const targetPosition =
      position ?? this.summaries.findIndex((summary) => summary.id === id);
    const data = safeStructuredClone(preset) as StoredBotPreset;
    delete (data as any).id;
    await commitSqlChanges(this.storage, {
      baseRevision: this.storage.getRevision(),
      action: "preset:save",
      root: { upserts: [], deletes: [] },
      presets: {
        upserts: [
          {
            id,
            position:
              targetPosition < 0 ? this.summaries.length : targetPosition,
            data,
          },
        ],
        deletes: [],
      },
      characters: [],
      chats: [],
      chatManifests: [],
      messages: [],
      messageManifests: [],
    });
    if (id === this.activeId && this.activePresetProvider) {
      this.cache.delete(id);
    } else {
      this.cache.set(id, { ...data, id });
    }
    this.summaries = await this.storage.listBotPresets();
  }
  async setActiveId(id: string, persist = true): Promise<void> {
    if (!this.storage || !this.summaries.some((preset) => preset.id === id))
      throw new Error("Active bot preset does not exist");
    this.activeId = id;
    this.activeStatus = "loading";
    this.error = null;
    try {
      await this.load(id);
      if (this.activePresetProvider) this.cache.delete(id);
      if (persist)
        await commitSqlChanges(this.storage, {
          baseRevision: this.storage.getRevision(),
          action: "preset:activate",
          root: { upserts: [], deletes: [] },
          presets: { upserts: [], deletes: [], activeId: id },
          characters: [],
          chats: [],
          chatManifests: [],
          messages: [],
          messageManifests: [],
        });
      this.activeStatus = "ready";
    } catch (error) {
      this.activeStatus = "error";
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
  async setActiveIndex(index: number): Promise<void> {
    const summary = this.summaries[index];
    if (!summary) throw new Error("Preset index is out of range");
    await this.setActiveId(summary.id);
  }
  async reorder(ids: string[]): Promise<void> {
    if (!this.storage) throw new Error("Preset store is not initialized");
    await commitSqlChanges(this.storage, {
      baseRevision: this.storage.getRevision(),
      action: "preset:reorder",
      root: { upserts: [], deletes: [] },
      presets: { upserts: [], deletes: [], order: ids },
      characters: [],
      chats: [],
      chatManifests: [],
      messages: [],
      messageManifests: [],
    });
    this.summaries = await this.storage.listBotPresets();
  }
  async delete(id: string): Promise<void> {
    if (!this.storage) throw new Error("Preset store is not initialized");
    if (this.summaries.length <= 1)
      throw new Error("At least one bot preset must remain");
    const index = this.summaries.findIndex((preset) => preset.id === id);
    if (index < 0) throw new Error("Preset not found");
    const nextActive =
      id === this.activeId
        ? this.summaries[index + 1]?.id || this.summaries[index - 1].id
        : this.activeId;
    const order = this.summaries
      .filter((preset) => preset.id !== id)
      .map((preset) => preset.id);
    await commitSqlChanges(this.storage, {
      baseRevision: this.storage.getRevision(),
      action: "preset:delete",
      root: { upserts: [], deletes: [] },
      presets: { upserts: [], deletes: [id], order, activeId: nextActive },
      characters: [],
      chats: [],
      chatManifests: [],
      messages: [],
      messageManifests: [],
    });
    this.cache.delete(id);
    this.activeId = nextActive;
    this.summaries = await this.storage.listBotPresets();
    await this.load(nextActive);
    this.activeStatus = "ready";
  }
  async setPresets(presets: botPreset[], activeIndex = 0): Promise<void> {
    if (!this.storage || presets.length === 0)
      throw new Error("At least one bot preset is required");
    const ids = presets.map(() => uuidv4());
    const selected = ids[Math.max(0, Math.min(activeIndex, ids.length - 1))];
    await commitSqlChanges(this.storage, {
      baseRevision: this.storage.getRevision(),
      action: "preset:replace",
      root: { upserts: [], deletes: [] },
      presets: {
        upserts: presets.map((data, position) => ({
          id: ids[position],
          position,
          data,
        })),
        deletes: this.summaries.map((preset) => preset.id),
        order: ids,
        activeId: selected,
      },
      characters: [],
      chats: [],
      chatManifests: [],
      messages: [],
      messageManifests: [],
    });
    this.cache.clear();
    this.summaries = await this.storage.listBotPresets();
    await this.setActiveId(selected, false);
  }
  async loadAll(): Promise<StoredBotPreset[]> {
    const result: StoredBotPreset[] = [];
    for (const summary of this.summaries)
      result.push(await this.load(summary.id));
    return result;
  }

  resetForTesting(): void {
    this.storage = null;
    this.activePresetProvider = null;
    this.summaries = [];
    this.activeId = "";
    this.presetCache.clear();
    this.listStatus = "idle";
    this.activeStatus = "idle";
    this.error = null;
  }
}

export const presetStore = new PresetStore();
