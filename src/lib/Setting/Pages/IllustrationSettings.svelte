<script lang="ts">
  import { language } from "src/lang";
  import { characterStore, settingsStore, presetStore } from "src/ts/stores/domain";
  import { DEFAULT_ILLUSTRATION_SETTINGS, resolveIllustrationSettings, type IllustrationSettings } from "@risuai/protocol/dist/illustration.mjs";
  import type { character } from "src/ts/storage/database/schema";
  import { prepareBrowserProviderContext } from "src/ts/process/request/providerContextAdapter";
  import { LLMFormat } from "src/ts/model/modellist";
  import { isNodeServer } from "src/ts/platform";
  import Help from "src/lib/Others/Help.svelte";

  let { characterId }: { characterId?: string } = $props();
  let char = $derived(characterStore.characters.find((c) => c.chaId === characterId) as character | undefined);
  let own = $derived(characterId ? char?.illustration ?? {} : settingsStore.state.illustration ?? DEFAULT_ILLUSTRATION_SETTINGS);
  let effective = $derived(resolveIllustrationSettings(settingsStore.state.illustration, char?.illustration));
  let browserSubmodel = $derived.by(() => {
    presetStore.state.subModel;
    const { prepared } = prepareBrowserProviderContext({ formated: [], bias: {} }, "submodel");
    return prepared.modelInfo.format === LLMFormat.Plugin || prepared.modelInfo.format === LLMFormat.WebLLM;
  });
  /**
   * Updates the owning settings store or deletes a character override to restore inheritance.
   *
   * 한국어: 설정 소유 저장소를 갱신하거나 캐릭터 변경값을 삭제해 범용 설정 상속을 복원하는 함수.
   *
   * @param key - Illustration setting being edited. / 편집할 삽화 설정 키.
   * @param value - New value, or undefined to inherit for a character. / 새 값 또는 캐릭터 상속 복원용 undefined.
   * @remarks
   * Global changes use settingsStore.set so deferred SQL persistence detects the new setting.
   * 한국어: 새 범용 설정을 지연 SQL 저장에서 감지하도록 settingsStore.set으로 변경.
   */
  function set<K extends keyof IllustrationSettings>(key: K, value: IllustrationSettings[K] | undefined) {
    if (characterId && char) {
      char.illustration = { ...char.illustration, [key]: value };
      if (value === undefined) delete char.illustration[key];
    } else {
      settingsStore.set("illustration", { ...DEFAULT_ILLUSTRATION_SETTINGS, ...settingsStore.state.illustration, [key]: value });
    }
  }
  function setDisplayWidth(input: HTMLInputElement) {
    if (input.value === "" && characterId) {
      set("displayWidth", undefined);
      return;
    }
    const width = resolveIllustrationSettings({
      displayWidth: input.value === "" ? DEFAULT_ILLUSTRATION_SETTINGS.displayWidth : input.valueAsNumber,
    }).displayWidth;
    input.value = String(width);
    set("displayWidth", width);
  }
  const booleans = ["enabled", "includeDescription", "includePersona", "includeLorebook", "includeMemory"] as const;
  const texts = ["markerInstructions", "tagInstructions", "basePrompt", "negativePrompt"] as const;
</script>

<section class="my-4 flex flex-col gap-3 rounded-md border border-darkborderc p-3 text-textcolor">
  <div class="flex items-center gap-1.5">
    <h3 class="font-bold">{language.illustration.title}</h3>
    <Help text={language.illustration.description} name={language.illustration.title} />
  </div>
  {#if characterId}<p class="text-sm text-textcolor2">{language.illustration.characterHelp}</p>{/if}
  {#if isNodeServer && browserSubmodel}<p class="text-sm text-draculared">{language.illustration.appFallback}</p>{/if}
  {#each booleans as key}
    <label class="flex items-center justify-between gap-2">
      <span>{language.illustration[key]}</span>
      <select class="rounded border border-darkborderc bg-darkbg p-1 text-textcolor" value={own[key] === undefined ? "inherit" : String(own[key])}
        onchange={(e) => set(key, e.currentTarget.value === "inherit" ? undefined : e.currentTarget.value === "true")}>
        {#if characterId}<option value="inherit">{language.illustration.inherit} ({effective[key] ? language.illustration.on : language.illustration.off})</option>{/if}
        <option value="true">{language.illustration.on}</option>
        <option value="false">{language.illustration.off}</option>
      </select>
    </label>
  {/each}
  <label class="flex items-center justify-between gap-2">
    <span>{language.illustration.displayWidth}</span>
    <span class="flex flex-wrap items-center justify-end gap-2">
      <input class="w-24 accent-textcolor" type="range" min="10" max="100" step="1" aria-label={language.illustration.displayWidth}
        value={effective.displayWidth} oninput={(e) => set("displayWidth", e.currentTarget.valueAsNumber)} />
      <input class="w-24 rounded border border-darkborderc bg-darkbg p-1" type="number" min="10" max="100" step="1" aria-label={language.illustration.displayWidth}
        value={own.displayWidth ?? (characterId ? "" : effective.displayWidth)} placeholder={String(effective.displayWidth)}
        onchange={(e) => setDisplayWidth(e.currentTarget)} />
      <span>%</span>
    </span>
  </label>
  <p class="text-sm text-textcolor2">{language.illustration.displayWidthHelp}</p>
  <label class="flex items-center justify-between gap-2">
    <span>{language.illustration.recentMessages}</span>
    <input class="w-24 rounded border border-darkborderc bg-darkbg p-1" type="number" min="0" step="1"
      value={own.recentMessages ?? ""} placeholder={String(effective.recentMessages)}
      oninput={(e) => set("recentMessages", e.currentTarget.value === "" && characterId ? undefined : Math.max(0, Math.floor(Number(e.currentTarget.value))))} />
  </label>
  {#each texts as key}
    <label class="flex flex-col gap-1">
      <span>{language.illustration[key]}</span>
      <textarea class="min-h-20 rounded border border-darkborderc bg-darkbg p-2 text-textcolor" value={own[key] ?? ""}
        oninput={(e) => set(key, e.currentTarget.value)}></textarea>
    </label>
  {/each}
</section>
