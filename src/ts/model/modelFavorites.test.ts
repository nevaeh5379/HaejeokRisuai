import { beforeEach, describe, expect, it } from "vitest";
import { modelFavoritesStore } from "./modelFavorites.svelte";

describe("modelFavoritesStore", () => {
  beforeEach(() => {
    modelFavoritesStore.clearRecent();
    for (const fav of [...modelFavoritesStore.favorites]) {
      modelFavoritesStore.toggleFavorite(fav);
    }
  });

  it("checks favorite membership in constant time and toggles favorites", () => {
    expect(modelFavoritesStore.isFavorite("model-a")).toBe(false);

    modelFavoritesStore.toggleFavorite("model-a");
    expect(modelFavoritesStore.isFavorite("model-a")).toBe(true);
    expect(modelFavoritesStore.favorites).toContain("model-a");

    modelFavoritesStore.toggleFavorite("model-a");
    expect(modelFavoritesStore.isFavorite("model-a")).toBe(false);
    expect(modelFavoritesStore.favorites).not.toContain("model-a");
  });

  it("adds recents and enforces max limit without duplicate entries", () => {
    modelFavoritesStore.addRecent("m1");
    modelFavoritesStore.addRecent("m2");
    modelFavoritesStore.addRecent("m1");

    expect(modelFavoritesStore.recent).toEqual(["m1", "m2"]);

    for (let i = 3; i <= 15; i++) {
      modelFavoritesStore.addRecent(`m${i}`);
    }

    expect(modelFavoritesStore.recent.length).toBe(10);
    expect(modelFavoritesStore.recent[0]).toBe("m15");
  });

  it("removes recent model", () => {
    modelFavoritesStore.addRecent("m1");
    modelFavoritesStore.addRecent("m2");
    modelFavoritesStore.removeRecent("m1");

    expect(modelFavoritesStore.recent).toEqual(["m2"]);
  });
});
