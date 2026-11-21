<script lang="ts">
  import { v4 as uuidv4 } from "uuid";
  import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
  import {
    DEFAULT_POCKET_REGISTRY_BASE_URL,
    getPocketRegistryBaseUrl,
    pocketRegistryStore,
    setPocketRegistryBaseUrl,
    type PocketRegistryProviderMeta,
  } from "src/ts/model/pocketRegistry/state.svelte";
  import { LLMFlags, LLMFormat, LLMTokenizer } from "src/ts/model/types";
  import TextInput from "src/lib/UI/GUI/TextInput.svelte";
  import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
  import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
  import Button from "src/lib/UI/GUI/Button.svelte";
  import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
  import {
    RefreshCwIcon,
    PlusIcon,
    Settings2Icon,
    RotateCcwIcon,
    CheckIcon,
    XIcon,
  } from "@lucide/svelte";

  interface Props {
    initialProviderId?: string;
    openAddFormSignal?: number;
  }

  let { initialProviderId = "openai", openAddFormSignal = 0 }: Props = $props();

  let showAdvancedUrl = $state(false);
  let showAddProviderModel = $state(false);
  let customUrlInput = $state(getPocketRegistryBaseUrl());

  let selectedProviderId = $state("openai");
  let newModelName = $state("");
  let newModelInternalId = $state("");
  let newModelEndpointOverride = $state("");
  let flagVision = $state(false);
  let flagThinking = $state(false);
  let flagStreaming = $state(true);
  let flagCompletionTokens = $state(false);
  let addFeedback = $state<string | null>(null);

  let lastHandledSignal = $state(0);
  $effect(() => {
    if (openAddFormSignal > lastHandledSignal) {
      lastHandledSignal = openAddFormSignal;
      if (initialProviderId) {
        selectedProviderId = initialProviderId;
      }
      showAddProviderModel = true;
    }
  });

  let availableProviders = $derived.by(() => {
    const list: PocketRegistryProviderMeta[] = [...pocketRegistryStore.providers];
    return list.sort((a, b) => a.providerGroup.localeCompare(b.providerGroup));
  });

  let currentProviderMeta = $derived(
    availableProviders.find((p) => p.id === selectedProviderId) ?? availableProviders[0],
  );

  async function handleSync(force = false) {
    setPocketRegistryBaseUrl(customUrlInput);
    try {
      await pocketRegistryStore.sync({ force, baseUrl: customUrlInput });
    } catch {
      // Error stored in pocketRegistryStore.lastError
    }
  }

  function handleResetUrl() {
    customUrlInput = DEFAULT_POCKET_REGISTRY_BASE_URL;
    setPocketRegistryBaseUrl(DEFAULT_POCKET_REGISTRY_BASE_URL);
  }

  function inferTokenizerForProvider(meta?: PocketRegistryProviderMeta, modelId = ""): LLMTokenizer {
    if (!meta) return LLMTokenizer.Unknown;
    if (meta.format === LLMFormat.Anthropic) return LLMTokenizer.Claude;
    if (meta.format === LLMFormat.GoogleCloud || meta.format === LLMFormat.VertexAIGemini) {
      return LLMTokenizer.GoogleCloud;
    }
    if (meta.id === "deepseek" || modelId.toLowerCase().includes("deepseek")) {
      return LLMTokenizer.DeepSeekV4;
    }
    if (meta.id === "openai" || modelId.toLowerCase().includes("gpt-")) {
      return LLMTokenizer.tiktokenO200Base;
    }
    return LLMTokenizer.Unknown;
  }

  function handleAddModelToProvider() {
    const meta = currentProviderMeta;
    const trimmedModelId = newModelInternalId.trim();
    const trimmedName = newModelName.trim() || trimmedModelId;
    if (!meta || !trimmedModelId) return;

    const flags: LLMFlags[] = [];
    if (flagStreaming) flags.push(LLMFlags.hasStreaming);
    if (flagVision) flags.push(LLMFlags.hasImageInput);

    if (meta.format === LLMFormat.Anthropic) {
      flags.push(LLMFlags.hasFirstSystemPrompt);
      if (flagThinking) {
        flags.push(LLMFlags.claudeThinking, LLMFlags.claudeAdaptiveThinking);
      }
    } else if (meta.format === LLMFormat.GoogleCloud || meta.format === LLMFormat.VertexAIGemini) {
      flags.push(
        LLMFlags.hasFirstSystemPrompt,
        LLMFlags.requiresAlternateRole,
        LLMFlags.poolSupported,
      );
      if (flagThinking) flags.push(LLMFlags.geminiThinking);
    } else {
      flags.push(LLMFlags.hasFullSystemPrompt);
      if (flagCompletionTokens) flags.push(LLMFlags.OAICompletionTokens);
      if (flagThinking && (meta.id === "deepseek" || trimmedModelId.toLowerCase().includes("deepseek"))) {
        flags.push(
          LLMFlags.deepSeekPrefix,
          LLMFlags.deepSeekThinkingInput,
          LLMFlags.deepSeekThinkingOutput,
          LLMFlags.deepSeekThinkingToggle,
        );
      }
    }

    const endpointUrl =
      newModelEndpointOverride.trim() ||
      (meta.format === LLMFormat.OpenAICompatible ? (meta.defaultEndpointUrl ?? "") : "");

    settingsStore.state.customModels ??= [];
    settingsStore.state.customModels = [
      ...settingsStore.state.customModels,
      {
        id: `xcustom:::${uuidv4()}`,
        name: trimmedName,
        internalId: trimmedModelId,
        url: endpointUrl,
        format: meta.format,
        tokenizer: inferTokenizerForProvider(meta, trimmedModelId),
        key: "",
        params: "",
        flags,
        providerGroup: meta.providerGroup,
        keyIdentifier: meta.keyIdentifier,
      },
    ];

    addFeedback = `[${meta.providerGroup}] 그룹에 "${trimmedName}" 모델이 추가되었습니다.`;
    newModelName = "";
    newModelInternalId = "";
    newModelEndpointOverride = "";
    setTimeout(() => {
      addFeedback = null;
    }, 3500);
  }
</script>

<div class="rounded-xl border border-darkborderc bg-darkbg/30 p-3 flex flex-col gap-2.5">
  <!-- Main Control Row -->
  <div class="flex flex-wrap items-center justify-between gap-2">
    <div class="flex items-center gap-2 min-w-0">
      <span class="text-xs font-bold text-textcolor">PocketRisu Model Registry</span>
      <span class="px-1.5 py-0.5 rounded bg-textcolor/10 text-textcolor2 text-[10px] font-mono">
        {pocketRegistryStore.meta.source === "remote" ? "Synced" : "Bundled"} · {pocketRegistryStore.meta.profileCount} models
        {#if pocketRegistryStore.meta.hash}
          · #{pocketRegistryStore.meta.hash.slice(0, 7)}
        {/if}
      </span>
    </div>

    <div class="flex flex-wrap items-center gap-1.5">
      <button
        class="px-2.5 py-1.5 rounded-lg bg-selected/80 hover:bg-selected text-textcolor text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
        disabled={pocketRegistryStore.syncing}
        onclick={() => handleSync(false)}
      >
        <RefreshCwIcon size={13} class={pocketRegistryStore.syncing ? "animate-spin" : ""} />
        <span>{pocketRegistryStore.syncing ? "동기화 중..." : "최신 모델 라인업 업데이트"}</span>
      </button>

      <button
        class="px-2.5 py-1.5 rounded-lg border border-darkborderc bg-darkbutton/70 hover:bg-darkbutton text-textcolor text-xs font-semibold flex items-center gap-1 transition-colors cursor-pointer"
        onclick={() => {
          showAddProviderModel = !showAddProviderModel;
        }}
      >
        <PlusIcon size={13} />
        <span>프로바이더에 모델 추가</span>
      </button>

      <button
        class="p-1.5 rounded-lg border border-darkborderc bg-darkbutton/50 hover:bg-darkbutton text-textcolor2 hover:text-textcolor transition-colors cursor-pointer"
        title="레지스트리 소스 설정"
        onclick={() => {
          showAdvancedUrl = !showAdvancedUrl;
        }}
      >
        <Settings2Icon size={14} />
      </button>
    </div>
  </div>

  {#if pocketRegistryStore.lastError}
    <div class="text-xs text-draculared bg-draculared/10 border border-draculared/30 rounded-lg px-2.5 py-1.5 flex items-center justify-between gap-2">
      <span>업데이트 오류: {pocketRegistryStore.lastError}</span>
      <button class="text-textcolor2 hover:text-textcolor cursor-pointer" onclick={() => { pocketRegistryStore.lastError = null; }}>
        <XIcon size={13} />
      </button>
    </div>
  {:else if pocketRegistryStore.lastStatusMessage}
    <div class="text-xs text-textcolor2 bg-darkbutton/50 border border-darkborderc/60 rounded-lg px-2.5 py-1.5 flex items-center justify-between gap-2">
      <span>{pocketRegistryStore.lastStatusMessage}</span>
      <button class="text-textcolor2 hover:text-textcolor cursor-pointer" onclick={() => { pocketRegistryStore.lastStatusMessage = null; }}>
        <XIcon size={13} />
      </button>
    </div>
  {/if}

  {#if showAdvancedUrl}
    <div class="pt-2 border-t border-darkborderc/50 flex flex-col gap-2 text-xs">
      <div class="flex items-center justify-between">
        <span class="text-textcolor2 font-medium">레지스트리 Raw Base URL (index.json / catalog.json 위치)</span>
        <div class="flex items-center gap-1.5">
          <button
            class="px-2 py-0.5 rounded bg-darkbutton hover:bg-darkbutton/80 text-textcolor2 hover:text-textcolor text-[11px] cursor-pointer"
            onclick={handleResetUrl}
          >
            공식 URL로 초기화
          </button>
          <button
            class="px-2 py-0.5 rounded bg-darkbutton hover:bg-darkbutton/80 text-textcolor2 hover:text-textcolor text-[11px] flex items-center gap-1 cursor-pointer"
            onclick={() => pocketRegistryStore.resetToBundled()}
          >
            <RotateCcwIcon size={11} /> 내장 스냅샷 복원
          </button>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <div class="flex-1">
          <TextInput
            size="sm"
            marginBottom={false}
            bind:value={customUrlInput}
            placeholder={DEFAULT_POCKET_REGISTRY_BASE_URL}
          />
        </div>
        <Button size="sm" styled="outlined" onclick={() => handleSync(true)}>강제 재다운로드</Button>
      </div>
    </div>
  {/if}

  {#if showAddProviderModel}
    <div class="pt-2.5 border-t border-darkborderc/60 flex flex-col gap-2.5 text-xs">
      <div class="flex items-center justify-between">
        <span class="font-bold text-textcolor">특정 프로바이더에 커스텀 모델 추가 (레지스트리 업데이트 시에도 유지됨)</span>
        <button class="text-textcolor2 hover:text-textcolor cursor-pointer" onclick={() => { showAddProviderModel = false; }}>
          <XIcon size={14} />
        </button>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div class="flex flex-col gap-1">
          <span class="text-textcolor2">소속 프로바이더</span>
          <SelectInput size="sm" bind:value={selectedProviderId}>
            {#each availableProviders as prov}
              <OptionInput value={prov.id}>{prov.providerGroup}</OptionInput>
            {/each}
          </SelectInput>
        </div>

        <div class="flex flex-col gap-1">
          <span class="text-textcolor2">요청 모델 ID (필수)</span>
          <TextInput
            size="sm"
            marginBottom={false}
            bind:value={newModelInternalId}
            placeholder="예: openai/gpt-6-preview"
          />
        </div>

        <div class="flex flex-col gap-1">
          <span class="text-textcolor2">표시 이름 (비워두면 ID 사용)</span>
          <TextInput
            size="sm"
            marginBottom={false}
            bind:value={newModelName}
            placeholder="예: GPT-6 Preview"
          />
        </div>
      </div>

      {#if currentProviderMeta?.format === LLMFormat.OpenAICompatible}
        <div class="flex flex-col gap-1">
          <span class="text-textcolor2">
            엔드포인트 URL 덮어쓰기 (선택 · 비워두면 {currentProviderMeta?.defaultEndpointUrl || "프로바이더 기본 URL"} 자동 사용)
          </span>
          <TextInput
            size="sm"
            marginBottom={false}
            bind:value={newModelEndpointOverride}
            placeholder={currentProviderMeta?.defaultEndpointUrl || "https://..."}
          />
        </div>
      {/if}

      <div class="flex flex-wrap items-center justify-between gap-2 pt-1">
        <div class="flex flex-wrap items-center gap-3">
          <CheckInput bind:check={flagStreaming} name="Streaming" />
          <CheckInput bind:check={flagVision} name="Vision (이미지 입력)" />
          <CheckInput bind:check={flagThinking} name="Thinking / Reasoning" />
          {#if currentProviderMeta?.format === LLMFormat.OpenAICompatible}
            <CheckInput bind:check={flagCompletionTokens} name="max_completion_tokens" />
          {/if}
        </div>

        <Button
          size="sm"
          onclick={handleAddModelToProvider}
        >
          <span class="flex items-center gap-1"><CheckIcon size={13} /> 프로바이더에 추가</span>
        </Button>
      </div>

      {#if addFeedback}
        <div class="text-xs text-textcolor bg-selected/30 border border-selected rounded-lg px-2.5 py-1.5">
          {addFeedback}
        </div>
      {/if}
    </div>
  {/if}
</div>
