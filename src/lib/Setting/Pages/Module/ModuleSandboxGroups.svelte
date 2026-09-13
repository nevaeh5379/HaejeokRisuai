<script lang="ts">
  import {
    Box,
    Boxes,
    ChevronDown,
    ChevronUp,
    Circle,
    CircleCheck,
    Plus,
    ShieldCheck,
    Trash2,
    X,
  } from "@lucide/svelte";
  import { language } from "src/lang";
  import ModelList from "src/lib/UI/ModelList.svelte";
  import { alertConfirm } from "src/ts/alert";
  import { moduleStore } from "src/ts/stores/domain/moduleStore.svelte";

  let selectedGroupId = $state("");
  let groups = $derived(moduleStore.sandboxGroups);
  let modules = $derived(moduleStore.list);
  let selectedGroup = $derived(
    groups.find((group) => group.id === selectedGroupId) ?? groups[0],
  );

  $effect(() => {
    if (!selectedGroupId && groups[0]) selectedGroupId = groups[0].id;
    if (
      selectedGroupId &&
      groups.length > 0 &&
      !groups.some((group) => group.id === selectedGroupId)
    ) {
      selectedGroupId = groups[0].id;
    }
  });

  async function createGroup() {
    const number = groups.length + 1;
    const group = await moduleStore.addSandboxGroup(
      `${language.moduleSandboxGroups.defaultName} ${number}`,
    );
    selectedGroupId = group.id;
  }

  async function removeGroup(id: string) {
    if (!(await alertConfirm(language.moduleSandboxGroups.removeGroupConfirm)))
      return;
    await moduleStore.removeSandboxGroup(id);
  }

  function moduleName(moduleId: string) {
    return (
      modules.find((module) => module.id === moduleId)?.name ??
      language.moduleSandboxGroups.missingModule
    );
  }
</script>

<section class="mt-4 rounded-xl border border-darkborderc bg-darkbg/40 overflow-hidden">
  <div class="flex flex-wrap items-center justify-between gap-3 border-b border-darkborderc bg-darkbutton/70 px-4 py-3">
    <div class="min-w-0">
      <h3 class="flex items-center gap-2 text-lg font-semibold">
        <Boxes size={20} />
        {language.moduleSandboxGroups.title}
      </h3>
      <p class="mt-1 text-sm text-textcolor2">
        {language.moduleSandboxGroups.description}
      </p>
    </div>
    <button
      type="button"
      class="flex min-h-11 items-center gap-2 rounded-lg border border-darkborderc bg-darkbutton px-3 py-2 hover:bg-selected cursor-pointer"
      onclick={createGroup}
    >
      <Plus size={18} />
      {language.moduleSandboxGroups.create}
    </button>
  </div>

  <div class="grid grid-cols-1 lg:grid-cols-[minmax(12rem,0.7fr)_minmax(0,2fr)]">
    <aside class="border-b border-darkborderc p-3 lg:border-r lg:border-b-0">
      <div class="flex items-center gap-2 font-medium">
        <Box size={18} />
        {language.moduleSandboxGroups.library}
      </div>
      <p class="mt-1 mb-3 text-xs text-textcolor2">
        {language.moduleSandboxGroups.addHint}
      </p>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-2">
        {#each modules as module (module.id)}
          {@const alreadyAdded = selectedGroup?.members.some((member) => member.moduleId === module.id)}
          <button
            type="button"
            class="flex min-h-12 items-center gap-2 rounded-lg border border-darkborderc bg-bgcolor px-3 py-2 text-left transition-colors hover:bg-selected disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer"
            disabled={!selectedGroup || alreadyAdded}
            onclick={() => selectedGroup && moduleStore.addModuleToSandbox(selectedGroup.id, module.id)}
          >
            {#if alreadyAdded}
              <CircleCheck size={17} class="text-green-500 shrink-0" />
            {:else}
              <Plus size={17} class="text-textcolor2 shrink-0" />
            {/if}
            <span class="min-w-0">
              <span class="block truncate font-medium">{module.name}</span>
              <span class="block truncate text-xs text-textcolor2">{module.description}</span>
            </span>
          </button>
        {:else}
          <p class="text-sm text-textcolor2">{language.moduleSandboxGroups.noModules}</p>
        {/each}
      </div>
    </aside>

    <div class="min-w-0 p-3">
      <div class="mb-3 flex items-center justify-between gap-2">
        <div class="font-medium">{language.moduleSandboxGroups.canvas}</div>
        {#if selectedGroup}
          <span class="truncate text-xs text-textcolor2">
            {language.moduleSandboxGroups.selected}: {selectedGroup.name}
          </span>
        {/if}
      </div>

      <div class="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {#each groups as group (group.id)}
          {@const isEnabled = moduleStore.enabledSandboxGroups.includes(group.id)}
          <article
            class="overflow-hidden rounded-xl border bg-bgcolor transition-colors {selectedGroupId === group.id ? 'border-blue-500 ring-2 ring-blue-500/15' : 'border-darkborderc'}"
          >
            <div class="border-b border-darkborderc bg-darkbutton/60 p-3">
              <div class="flex items-start gap-2">
                <button
                  type="button"
                  class="min-w-0 grow text-left cursor-pointer"
                  onclick={() => selectedGroupId = group.id}
                >
                  <input
                    aria-label={language.moduleSandboxGroups.title}
                    class="w-full rounded-md border border-transparent bg-transparent px-1 py-1 font-semibold hover:border-darkborderc focus:border-blue-500"
                    value={group.name}
                    onclick={(event) => event.stopPropagation()}
                    onchange={(event) => moduleStore.updateSandboxGroup(group.id, { name: event.currentTarget.value.trim() || language.moduleSandboxGroups.defaultName })}
                  />
                  <span class="mt-1 block text-xs text-textcolor2">
                    {group.members.length} {language.moduleSandboxGroups.library}
                  </span>
                </button>

                <button
                  type="button"
                  aria-pressed={isEnabled}
                  class="flex min-h-10 shrink-0 items-center gap-1 rounded-lg border border-darkborderc px-2 py-1.5 cursor-pointer {isEnabled ? 'bg-blue-500/15 text-blue-500' : 'bg-darkbutton text-textcolor2'}"
                  onclick={() => moduleStore.toggleSandboxGroup(group.id)}
                >
                  {#if isEnabled}<CircleCheck size={17} />{:else}<Circle size={17} />{/if}
                  {isEnabled ? language.moduleSandboxGroups.active : language.moduleSandboxGroups.inactive}
                </button>

                <button
                  type="button"
                  class="flex size-10 shrink-0 items-center justify-center rounded-lg text-textcolor2 hover:bg-textcolor/10 hover:text-draculared cursor-pointer"
                  aria-label={language.remove}
                  onclick={() => removeGroup(group.id)}
                >
                  <Trash2 size={17} />
                </button>
              </div>

              <div class="mt-3 flex flex-wrap items-end justify-between gap-2">
                <label class="text-xs text-textcolor2">
                  {language.moduleSandboxGroups.model}
                  <div class="mt-1 text-textcolor">
                    <ModelList
                      value={group.subModel}
                      onChange={(value) => moduleStore.updateSandboxGroup(group.id, { subModel: value })}
                      blankable
                      noneText={language.moduleSandboxGroups.globalModel}
                      noMargin
                    />
                  </div>
                </label>
                <span class="flex items-center gap-1 text-xs text-green-500">
                  <ShieldCheck size={16} />
                  {isEnabled ? language.moduleSandboxGroups.active : language.moduleSandboxGroups.inactive}
                </span>
              </div>
            </div>

            <div class="relative flex flex-col gap-2 p-3">
              <div class="absolute top-5 bottom-5 left-[1.45rem] w-px bg-darkborderc"></div>
              {#each group.members as member, index (member.instanceId)}
                {@const definition = modules.find((module) => module.id === member.moduleId)}
                <div class="relative z-[1] ml-3 rounded-lg border border-darkborderc bg-selected/25 p-3">
                  <span class="absolute -left-[1.05rem] top-4 size-3 rounded-full border-[3px] border-blue-500 bg-bgcolor"></span>
                  <div class="flex items-center gap-2">
                    <Box size={17} class="shrink-0" />
                    <div class="min-w-0 grow">
                      <div class="truncate font-medium">{definition?.name ?? moduleName(member.moduleId)}</div>
                      <div class="truncate font-mono text-[11px] text-textcolor2">
                        {language.moduleSandboxGroups.instance} {member.instanceId.slice(0, 8)}
                      </div>
                    </div>
                    <div class="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        disabled={index === 0}
                        class="flex size-9 items-center justify-center rounded-md hover:bg-textcolor/10 disabled:opacity-30 cursor-pointer"
                        aria-label="Move up"
                        onclick={() => moduleStore.moveSandboxModule(group.id, member.instanceId, 'up')}
                      ><ChevronUp size={16} /></button>
                      <button
                        type="button"
                        disabled={index === group.members.length - 1}
                        class="flex size-9 items-center justify-center rounded-md hover:bg-textcolor/10 disabled:opacity-30 cursor-pointer"
                        aria-label="Move down"
                        onclick={() => moduleStore.moveSandboxModule(group.id, member.instanceId, 'down')}
                      ><ChevronDown size={16} /></button>
                      <button
                        type="button"
                        class="flex size-9 items-center justify-center rounded-md text-textcolor2 hover:bg-textcolor/10 hover:text-draculared cursor-pointer"
                        aria-label={language.remove}
                        onclick={() => moduleStore.removeModuleFromSandbox(group.id, member.instanceId)}
                      ><X size={16} /></button>
                    </div>
                  </div>
                  {#if !definition}
                    <div class="mt-2 text-xs text-draculared">{language.moduleSandboxGroups.missingModule}: {member.moduleId}</div>
                  {/if}
                </div>
              {:else}
                <div class="ml-3 rounded-lg border border-dashed border-darkborderc p-4 text-center text-sm text-textcolor2">
                  {language.moduleSandboxGroups.emptyGroup}
                </div>
              {/each}
            </div>

            <div class="flex items-start gap-2 border-t border-dashed border-darkborderc px-3 py-2 text-xs text-textcolor2">
              <ShieldCheck size={15} class="mt-0.5 shrink-0" />
              <span>{language.moduleSandboxGroups.isolated}</span>
            </div>
          </article>
        {:else}
          <div class="rounded-lg border border-dashed border-darkborderc p-6 text-center text-textcolor2 xl:col-span-2">
            {language.moduleSandboxGroups.noGroups}
          </div>
        {/each}
      </div>

      {#if groups.length > 0}
        <p class="mt-3 text-xs text-textcolor2">
          {language.moduleSandboxGroups.legacyWarning}
        </p>
      {/if}
    </div>
  </div>
</section>
