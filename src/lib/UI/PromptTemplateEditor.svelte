<script lang="ts">
  /**
   * Reusable prompt-template list editor.
   *
   * Owns the drag/reorder/remove/add/tokenize behavior for a `PromptItem[]`
   * that the caller provides, so the ordinary Prompt Settings page and the
   * Risu Agent prompt modal share exactly one implementation. `template` is
   * bindable; pass `promptSettings` so PromptDataItem can render the fields
   * that depend on the prompt settings of the same owner.
   */
  import { onDestroy, onMount } from "svelte";
  import {
    ChevronsUpDown,
    ChevronDown,
    PlusIcon,
  } from "@lucide/svelte";
  import { language } from "src/lang";
  import PromptDataItem from "src/lib/UI/PromptDataItem.svelte";
  import { tokenizePreset, type PromptItem, type PromptSettings } from "src/ts/process/prompt";
  import { templateCheck } from "src/ts/process/templates/templateCheck";

  interface Props {
    template: PromptItem[];
    promptSettings?: PromptSettings;
    /** Extra classes for the scroll container. */
    listClassName?: string;
    /** Renders the token summary under the list. */
    showTokenCounts?: boolean;
  }

  let {
    template = $bindable(),
    promptSettings,
    listClassName = "p-3",
    showTokenCounts = true,
  }: Props = $props();

  let sorted = 0;
  let warns: string[] = $state([]);
  let tokens = $state(0);
  let extokens = $state(0);
  let draggedIndex = $state(-1);
  let dragOverIndex = $state(-1);
  let openedItemIndices = $state(new Set<number>());
  let addNewPromptOpen = $state(false);

  const promptTypeOptions: {
    type: string;
    label: string;
    defaults: Partial<PromptItem>;
  }[] = [
    { type: "plain", label: language.formating.plain, defaults: { type: "plain", text: "", role: "system", type2: "normal" } as any },
    { type: "jailbreak", label: language.formating.jailbreak, defaults: { type: "jailbreak", text: "", role: "system", type2: "normal" } as any },
    { type: "chat", label: language.Chat, defaults: { type: "chat", rangeStart: -1000, rangeEnd: "end" } as any },
    { type: "persona", label: language.formating.personaPrompt, defaults: { type: "persona" } as any },
    { type: "description", label: language.formating.description, defaults: { type: "description" } as any },
    { type: "authornote", label: language.formating.authorNote, defaults: { type: "authornote" } as any },
    { type: "lorebook", label: language.formating.lorebook, defaults: { type: "lorebook" } as any },
    { type: "memory", label: language.formating.memory, defaults: { type: "memory" } as any },
    { type: "postEverything", label: language.formating.postEverything, defaults: { type: "postEverything" } as any },
    { type: "chatML", label: "ChatML", defaults: { type: "chatML", text: "" } as any },
    { type: "cache", label: language.cachePoint ?? "Cache", defaults: { type: "cache", name: "", depth: 1, role: "all" } as any },
  ];

  async function executeTokenize(preset: PromptItem[]) {
    tokens = await tokenizePreset(preset, true);
    extokens = await tokenizePreset(preset, false);
  }

  $effect.pre(() => {
    warns = templateCheck(template);
  });
  $effect.pre(() => {
    void executeTokenize(template);
  });

  function getDisplayTemplate() {
    return template.map((item: any, i: number) => ({
      item,
      originalIndex: i,
      displayIndex: i,
    }));
  }

  function getReorderedTemplate() {
    if (draggedIndex === -1 || dragOverIndex === -1 || draggedIndex === dragOverIndex) {
      return getDisplayTemplate();
    }

    const items = getDisplayTemplate();
    const [movedItem] = items.splice(draggedIndex, 1);

    const adjustedDropIndex = draggedIndex < dragOverIndex ? dragOverIndex - 1 : dragOverIndex;
    items.splice(adjustedDropIndex, 0, movedItem);

    return items.map((item: any, displayIndex: number) => ({
      ...item,
      displayIndex,
    }));
  }

  function removePrompt(originalIndex: number) {
    const templates = template;
    templates.splice(originalIndex, 1);
    template = templates;

    const newOpenedIndices = new Set<number>();
    openedItemIndices.forEach((index) => {
      if (index === originalIndex) {
        return;
      } else if (index > originalIndex) {
        newOpenedIndices.add(index - 1);
      } else {
        newOpenedIndices.add(index);
      }
    });
    openedItemIndices = newOpenedIndices;

    draggedIndex = -1;
    dragOverIndex = -1;
  }

  function movePrompt(originalIndex: number, direction: -1 | 1) {
    const target = originalIndex + direction;
    if (target < 0 || target >= template.length) {
      return;
    }
    const templates = template;
    const temp = templates[originalIndex];
    templates[originalIndex] = templates[target];
    templates[target] = temp;
    template = templates;

    const newOpenedIndices = new Set<number>();
    openedItemIndices.forEach((index) => {
      if (index === originalIndex) {
        newOpenedIndices.add(target);
      } else if (index === target) {
        newOpenedIndices.add(originalIndex);
      } else {
        newOpenedIndices.add(index);
      }
    });
    openedItemIndices = newOpenedIndices;
  }

  function handlePromptDrop() {
    if (draggedIndex === -1 || dragOverIndex === -1 || draggedIndex === dragOverIndex) {
      return;
    }

    const templates = [...template];
    const [movedItem] = templates.splice(draggedIndex, 1);

    const adjustedDropIndex = draggedIndex < dragOverIndex ? dragOverIndex - 1 : dragOverIndex;
    templates.splice(adjustedDropIndex, 0, movedItem);

    const newOpenedIndices = new Set<number>();
    openedItemIndices.forEach((index) => {
      if (index === draggedIndex) {
        newOpenedIndices.add(adjustedDropIndex);
      } else if (draggedIndex < adjustedDropIndex) {
        if (index > draggedIndex && index <= adjustedDropIndex) {
          newOpenedIndices.add(index - 1);
        } else {
          newOpenedIndices.add(index);
        }
      } else {
        if (index >= adjustedDropIndex && index < draggedIndex) {
          newOpenedIndices.add(index + 1);
        } else {
          newOpenedIndices.add(index);
        }
      }
    });
    openedItemIndices = newOpenedIndices;

    template = templates;
    draggedIndex = -1;
    dragOverIndex = -1;
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.altKey && e.key === "o") {
      if (openedItemIndices.size === template.length) {
        openedItemIndices = new Set<number>();
      } else {
        openedItemIndices = new Set<number>(template.map((_: any, i: number) => i));
      }
    }
  };

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown);
  });

  onDestroy(() => {
    document.removeEventListener("keydown", handleKeyDown);
  });

  function addPromptWithType(defaults: Partial<PromptItem>) {
    const value = template ?? [];
    value.push(defaults as PromptItem);
    template = value;
    addNewPromptOpen = false;
  }
</script>

{#if warns.length > 0}
  <div class="text-red-500 flex flex-col items-start p-2 rounded-md border-red-500 border mt-4">
    <h2 class="text-xl font-bold">Warning</h2>
    <div class="border-b border-b-red-500 mt-1 mb-2 w-full"></div>
    {#each warns as warn}
      <span class="ml-4">{warn}</span>
    {/each}
  </div>
{/if}

<!-- Toolbar -->
<div class="flex items-center justify-between mt-4 mb-1 px-1">
  <span class="text-xs text-textcolor2">{template.length} items</span>
  <button
    class="text-xs px-2 py-1 rounded border border-darkborderc text-textcolor2 hover:text-textcolor hover:bg-selected transition-colors flex items-center gap-1 cursor-pointer"
    onclick={() => {
      if (openedItemIndices.size === template.length) {
        openedItemIndices = new Set<number>();
      } else {
        openedItemIndices = new Set<number>(template.map((_: any, i: number) => i));
      }
    }}
  >
    <ChevronsUpDown size={13} />
    {openedItemIndices.size === template.length ? "Collapse All" : "Expand All"}
  </button>
</div>
<div class="contain w-full max-w-full flex flex-col rounded-md {listClassName}">
  {#if template.length === 0}
    <div class="text-textcolor2">No Format</div>
  {/if}
  {#key sorted}
    {#each getReorderedTemplate() as { item, originalIndex, displayIndex }}
      <PromptDataItem
        bind:promptItem={template[originalIndex]}
        template={template}
        {promptSettings}
        isDragging={draggedIndex === originalIndex}
        isOpened={openedItemIndices.has(originalIndex)}
        bind:draggedIndex
        bind:dragOverIndex
        bind:openedItemIndices
        currentIndex={originalIndex}
        {displayIndex}
        onDrop={handlePromptDrop}
        onRemove={() => removePrompt(originalIndex)}
        moveDown={() => movePrompt(originalIndex, 1)}
        moveUp={() => movePrompt(originalIndex, -1)}
      />
    {/each}
  {/key}
</div>

<!-- Add prompt dropdown -->
<div class="relative mt-2">
  <button
    class="font-medium cursor-pointer hover:text-green-500 flex items-center gap-1 text-sm"
    onclick={() => {
      addNewPromptOpen = !addNewPromptOpen;
    }}
  >
    <PlusIcon size={18} />
    <ChevronDown size={14} />
  </button>
  {#if addNewPromptOpen}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="fixed inset-0 z-40" onclick={() => { addNewPromptOpen = false }}></div>
    <div class="absolute left-0 bottom-full mb-1 z-50 bg-darkbg border border-darkborderc rounded-lg shadow-lg py-1 min-w-48 max-h-64 overflow-y-auto">
      {#each promptTypeOptions as opt}
        <button
          class="w-full text-left px-3 py-1.5 text-sm text-textcolor hover:bg-selected transition-colors cursor-pointer"
          onclick={() => addPromptWithType(opt.defaults)}
        >
          {opt.label}
        </button>
      {/each}
    </div>
  {/if}
</div>

{#if showTokenCounts}
  <span class="text-textcolor2 text-sm mt-2">{tokens} {language.fixedTokens}</span>
  <span class="text-textcolor2 mb-6 text-sm mt-2">{extokens} {language.exactTokens}</span>
{/if}
