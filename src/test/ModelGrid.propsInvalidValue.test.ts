/**
 * Regression tests for the `https://svelte.dev/e/props_invalid_value` crash
 * reported on Risu b6595 (Windows, node environment).
 *
 * Report: opening Bot Settings threw
 *   "props_invalid_value — Cannot do `bind:value={undefined}` when `value` has a fallback value"
 * from src/lib/UI/ModelGrid.svelte:16 (mounted from BotSettings.svelte:883).
 *
 * Trigger chain:
 *  1. Provider model overrides keep their string fields `undefined` while unset by
 *     design (`normalizeProviderModelOverrides` -> `optionalString()`, asserted in
 *     src/ts/storage/database/databaseDefaults.test.ts).
 *  2. BotSettings renders `<ModelGrid bind:value={currentOverride.ollamaCloudModel}>`
 *     (same for openrouterRequestModel / nanogptRequestModel), so the binding
 *     receives `undefined`.
 *  3. Old ModelGrid declared `value = $bindable('')` — a bindable prop WITH a
 *     fallback. Svelte 5 throws props_invalid_value exactly for that case
 *     (svelte@5.57.0, internal/client/reactivity/props.js:
 *     `initial_value === undefined && fallback !== undefined` while a setter exists).
 *
 * Fix: ModelGrid now uses the fallback-free form `value = $bindable()`, the same
 * pattern TextInput.svelte already used when binding these override fields.
 *
 * The first test reproduces the original crash against a fixture carrying the old
 * signature; the remaining tests pin the fixed component's behavior.
 */

import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { Component } from "svelte";
import ModelGrid from "src/lib/UI/ModelGrid.svelte";
import ModelGridOldBindable from "./fixtures/OldModelGridBindable.svelte";
import { ProviderModelOverrideState } from "./fixtures/ProviderModelOverrideState.svelte";
import type { ModelGridItem } from "src/ts/model/modelGrid";

/** Mounted component handle kept for cleanup in afterEach. */
let mounted: { app: Record<string, any>; target: HTMLElement } | undefined;

/**
 * Programmatic equivalent of `bind:value={override.ollamaCloudModel}` in BotSettings.
 * Svelte's mount() detects two-way bindings through accessor descriptors on the props
 * object (`Object.getOwnPropertyDescriptor(props, key)?.set` in props.js), so
 * `value` must be defined as a getter/setter pair instead of a plain value.
 */
function botSettingsStyleProps(
  override: ProviderModelOverrideState,
  rest: Record<string, unknown> = {},
): Record<string, unknown> {
  const props: Record<string, unknown> = { ...rest };
  Object.defineProperty(props, "value", {
    get: () => override.ollamaCloudModel,
    set: (v: string) => {
      override.ollamaCloudModel = v;
    },
    enumerable: true,
  });
  return props;
}

function mountComponent(
  component: unknown,
  props: Record<string, unknown>,
): { app: Record<string, any>; target: HTMLElement } {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const app = mount(component as unknown as Component<Record<string, any>>, {
    target,
    props: props as Record<string, any>,
  });
  mounted = { app, target };
  return mounted;
}

function modelGridItem(id: string, displayName: string): ModelGridItem {
  return {
    id,
    displayName,
    providerName: "Ollama Cloud",
    description: "",
    context_length: 0,
    sortPrice: 0,
    prices: [],
  };
}

describe("ModelGrid props_invalid_value regression (Risu b6595 report)", () => {
  afterEach(() => {
    if (mounted) {
      unmount(mounted.app);
      mounted.target.remove();
      mounted = undefined;
    }
  });

  it("reproduces the crash: binding undefined into a $bindable prop that has a fallback throws props_invalid_value", () => {
    const override = new ProviderModelOverrideState();

    // The old ModelGrid signature ($bindable('')) + BotSettings' undefined binding.
    // Verbatim message from svelte@5.57.0 internal/client/errors.js (DEV build).
    expect(() =>
      mountComponent(
        ModelGridOldBindable,
        botSettingsStyleProps(override, { loading: true }),
      ),
    ).toThrowError(
      /props_invalid_value[\s\S]*Cannot do `bind:value=\{undefined\}` when `value` has a fallback value/,
    );
  });

  it("documents the mechanism: passing undefined as a plain (non-bind:) prop never threw", () => {
    // Without a setter there is no two-way binding, so props.js never reaches the
    // throw — this is why only the `bind:` call sites in BotSettings crashed.
    mountComponent(ModelGridOldBindable, { value: undefined });
    expect(mounted?.target.querySelector("p")?.textContent?.trim()).toBe("–");
  });

  it("fixed behavior: mounts without throwing when bound like BotSettings (<ModelGrid bind:value={currentOverride.ollamaCloudModel} loading={true} />)", () => {
    const override = new ProviderModelOverrideState();

    expect(() =>
      mountComponent(
        ModelGrid,
        botSettingsStyleProps(override, { loading: true }),
      ),
    ).not.toThrow();

    // Still renders the loading spinner instead of crashing.
    expect(mounted?.target.querySelector(".animate-spin")).toBeTruthy();
  });

  it("fixed behavior: unset binding (undefined) shows the placeholder label and stays selectable", () => {
    const override = new ProviderModelOverrideState();
    const { target } = mountComponent(
      ModelGrid,
      botSettingsStyleProps(override, {
        items: [
          modelGridItem("qwen3-8b", "Qwen3 8B"),
          modelGridItem("gpt-oss-20b", "GPT-OSS 20B"),
        ],
      }),
    );

    const label = () => target.querySelector("p")?.textContent?.trim();
    expect(label()).toContain("–");

    const card = [...target.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Qwen3 8B"),
    );
    expect(card).toBeTruthy();

    card!.click();
    flushSync();

    // The write-back goes through the binding into the override object,
    // exactly like botSettings' currentOverride.ollamaCloudModel would.
    expect(override.ollamaCloudModel).toBe("qwen3-8b");
    expect(label()).toContain("Ollama Cloud / Qwen3 8B");
  });

  it("fixed behavior: pinned items write back correctly from an undefined initial value", () => {
    const override = new ProviderModelOverrideState();
    const { target } = mountComponent(
      ModelGrid,
      botSettingsStyleProps(override, {
        pinnedItems: [
          { id: "risu/free", displayName: "Free Auto", providerName: "Risu" },
        ],
      }),
    );

    const pinned = [...target.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Free Auto"),
    );
    expect(pinned).toBeTruthy();

    pinned!.click();
    flushSync();

    expect(override.ollamaCloudModel).toBe("risu/free");
  });
});
