const FAVORITES_STORAGE_KEY = "risu_favorite_models";
const RECENT_STORAGE_KEY = "risu_recent_models";
const MAX_RECENT_MODELS = 10;

function loadFromStorage(key: string): string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const item = localStorage.getItem(key);
    if (!item) return [];
    const parsed = JSON.parse(item);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveToStorage(key: string, data: string[]) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    // Ignore storage errors (e.g. quota exceeded or private mode)
  }
}

class ModelFavoritesStore {
  favorites = $state<string[]>(loadFromStorage(FAVORITES_STORAGE_KEY));
  recent = $state<string[]>(loadFromStorage(RECENT_STORAGE_KEY));
  favoritesSet = $derived(new Set(this.favorites));

  isFavorite(modelId: string): boolean {
    if (!modelId) return false;
    return this.favoritesSet.has(modelId);
  }

  toggleFavorite(modelId: string) {
    if (!modelId) return;
    if (this.favoritesSet.has(modelId)) {
      this.favorites = this.favorites.filter((id) => id !== modelId);
    } else {
      this.favorites = [...this.favorites, modelId];
    }
    saveToStorage(FAVORITES_STORAGE_KEY, $state.snapshot(this.favorites));
  }

  addRecent(modelId: string) {
    if (!modelId) return;
    const next: string[] = [modelId];
    for (const id of this.recent) {
      if (id !== modelId) {
        next.push(id);
        if (next.length >= MAX_RECENT_MODELS) break;
      }
    }
    this.recent = next;
    saveToStorage(RECENT_STORAGE_KEY, $state.snapshot(this.recent));
  }

  removeRecent(modelId: string) {
    if (!modelId) return;
    this.recent = this.recent.filter((id) => id !== modelId);
    saveToStorage(RECENT_STORAGE_KEY, $state.snapshot(this.recent));
  }

  clearRecent() {
    this.recent = [];
    saveToStorage(RECENT_STORAGE_KEY, []);
  }
}

export const modelFavoritesStore = new ModelFavoritesStore();
