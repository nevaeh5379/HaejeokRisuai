import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import SavePopupIcon from "./SavePopupIcon.svelte";
import { saving } from "src/ts/stores.svelte";
import { settingsStore } from "src/ts/stores/domain";

describe("SavePopupIcon", () => {
  let target: HTMLDivElement;
  let instance: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    target = document.createElement("div");
    document.body.appendChild(target);
    settingsStore.state.showSavingIcon = true;
    saving.state = false;
  });

  afterEach(() => {
    if (instance) {
      unmount(instance);
      instance = null;
    }
    target.remove();
    vi.useRealTimers();
  });

  it("does not render when saving is false and no save has occurred", () => {
    instance = mount(SavePopupIcon, { target });
    flushSync();
    expect(target.querySelector("svg")).toBeNull();
  });

  it("renders saving state while saving.state is true, then transitions to saved state", () => {
    instance = mount(SavePopupIcon, { target });
    flushSync();
    expect(target.querySelector("svg")).toBeNull();

    // Start saving
    saving.state = true;
    flushSync();

    const savingContainer = target.querySelector("div.saving-animation");
    expect(savingContainer).not.toBeNull();
    expect(savingContainer?.className).toContain("from-blue-500");

    // Finish saving
    saving.state = false;
    flushSync();

    // Should now show saved state (emerald gradient, CheckIcon)
    const savedContainer = target.querySelector("div.bg-linear-to-br");
    expect(savedContainer).not.toBeNull();
    expect(savedContainer?.className).toContain("from-emerald-500");
    expect(savedContainer?.className).not.toContain("saving-animation");

    // Advance timer past 2500ms
    vi.advanceTimersByTime(2600);
    flushSync();

    // Icon should disappear
    expect(target.querySelector("svg")).toBeNull();
  });

  it("does not render if showSavingIcon is disabled", () => {
    settingsStore.state.showSavingIcon = false;
    instance = mount(SavePopupIcon, { target });
    flushSync();

    saving.state = true;
    flushSync();
    expect(target.querySelector("svg")).toBeNull();

    saving.state = false;
    flushSync();
    expect(target.querySelector("svg")).toBeNull();
  });
});
