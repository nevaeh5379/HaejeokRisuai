<script lang="ts">
  import { language } from "src/lang";
  import ModelList from "src/lib/UI/ModelList.svelte";
  import { alertConfirm, alertInput } from "src/ts/alert";
  import type { ModuleSandboxGroup } from "src/ts/process/modules";
  import { moduleStore } from "src/ts/stores/domain/moduleStore.svelte";

  type Position = { x: number; y: number };
  type DragState = {
    groupId: string;
    pointerId: number;
    startX: number;
    startY: number;
    origin: Position;
  };

  let groups = $derived(moduleStore.sandboxGroups);
  let modules = $derived(moduleStore.list);
  let positions = $state<Record<string, Position>>({});
  let moduleChoice = $state<Record<string, string>>({});
  let dragging = $state<DragState | null>(null);

  let canvasWidth = $derived.by(() => {
    let width = 1200;
    groups.forEach((group, index) => {
      width = Math.max(width, groupPosition(group, index).x + 360);
    });
    return width;
  });

  let canvasHeight = $derived.by(() => {
    let height = 720;
    groups.forEach((group, index) => {
      height = Math.max(height, groupPosition(group, index).y + 520);
    });
    return height;
  });

  function defaultPosition(index: number): Position {
    return {
      x: 32 + (index % 3) * 340,
      y: 32 + Math.floor(index / 3) * 360,
    };
  }

  function groupPosition(group: ModuleSandboxGroup, index: number): Position {
    const position = positions[group.id] ?? group.position;
    if (
      position &&
      Number.isFinite(position.x) &&
      Number.isFinite(position.y)
    ) {
      return position;
    }
    return defaultPosition(index);
  }

  async function createGroup(position = defaultPosition(groups.length)) {
    await moduleStore.addSandboxGroup(
      `${language.moduleSandboxGroups.bundle} ${groups.length + 1}`,
      position,
    );
  }

  async function createGroupAt(event: MouseEvent) {
    if (event.target !== event.currentTarget) return;
    const canvas = event.currentTarget as HTMLDivElement;
    const rect = canvas.getBoundingClientRect();
    await createGroup({
      x: Math.max(0, Math.round(event.clientX - rect.left - 150)),
      y: Math.max(0, Math.round(event.clientY - rect.top - 24)),
    });
  }

  async function removeGroup(id: string) {
    if (!(await alertConfirm(language.moduleSandboxGroups.removeGroupConfirm)))
      return;
    await moduleStore.removeSandboxGroup(id);
    delete positions[id];
    delete moduleChoice[id];
  }

  async function renameGroup(group: ModuleSandboxGroup) {
    const name = await alertInput(
      language.moduleSandboxGroups.title,
      undefined,
      group.name,
    );
    if (!name?.trim()) return;
    await moduleStore.updateSandboxGroup(group.id, { name: name.trim() });
  }

  async function addModule(groupId: string) {
    const moduleId = moduleChoice[groupId];
    if (!moduleId) return;
    await moduleStore.addModuleToSandbox(groupId, moduleId);
    moduleChoice[groupId] = "";
  }

  function startDrag(
    event: PointerEvent,
    group: ModuleSandboxGroup,
    index: number,
  ) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, select")) return;
    const origin = groupPosition(group, index);
    dragging = {
      groupId: group.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { ...origin },
    };
    positions[group.id] = { ...origin };
    event.preventDefault();
  }

  function moveDrag(event: PointerEvent) {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    positions[dragging.groupId] = {
      x: Math.max(
        0,
        Math.round(dragging.origin.x + event.clientX - dragging.startX),
      ),
      y: Math.max(
        0,
        Math.round(dragging.origin.y + event.clientY - dragging.startY),
      ),
    };
  }

  async function endDrag(event: PointerEvent) {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    const completed = dragging;
    dragging = null;
    const position = positions[completed.groupId];
    if (position) {
      await moduleStore.updateSandboxGroup(completed.groupId, { position });
    }
  }

  function moduleName(moduleId: string) {
    return (
      modules.find((module) => module.id === moduleId)?.name ??
      language.moduleSandboxGroups.missingModule
    );
  }
</script>

<svelte:window
  onpointermove={moveDrag}
  onpointerup={endDrag}
  onpointercancel={endDrag}
/>

<div class="flex justify-end pb-3">
  <button
    type="button"
    class="rounded-md border border-darkborderc bg-darkbutton px-3 py-2 text-sm hover:bg-selected cursor-pointer"
    onclick={() => createGroup()}
  >{language.moduleSandboxGroups.new}</button>
</div>

<div class="h-[70vh] min-h-[32rem] overflow-auto rounded-lg border border-darkborderc bg-darkbg">
  <div
    class="relative text-textcolor/10"
    style={`width: ${canvasWidth}px; height: ${canvasHeight}px; background-image: radial-gradient(currentColor 1px, transparent 1px); background-size: 24px 24px;`}
    role="region"
    aria-label={language.moduleSandboxGroups.title}
    ondblclick={createGroupAt}
  >
    {#each groups as group, index (group.id)}
      {@const position = groupPosition(group, index)}
      <section
        data-testid="module-sandbox-node"
        class="absolute w-[19rem] overflow-hidden rounded-lg border border-darkborderc bg-bgcolor text-textcolor shadow-lg {dragging?.groupId === group.id ? 'z-20 shadow-xl' : 'z-10'}"
        style={`left: ${position.x}px; top: ${position.y}px;`}
      >
        <div
          class="flex min-h-12 touch-none items-center gap-2 border-b border-darkborderc bg-darkbutton px-3 cursor-grab active:cursor-grabbing"
          role="toolbar"
          tabindex="0"
          aria-label={group.name}
          onpointerdown={(event) => startDrag(event, group, index)}
        >
          <span class="min-w-0 grow truncate font-semibold">{group.name}</span>
          <button
            type="button"
            class="shrink-0 rounded px-2 py-1 text-xs text-textcolor2 hover:bg-textcolor/10 hover:text-textcolor cursor-pointer"
            onclick={() => renameGroup(group)}
          >{language.edit}</button>
          <button
            type="button"
            class="shrink-0 rounded px-2 py-1 text-xs text-textcolor2 hover:bg-textcolor/10 hover:text-draculared cursor-pointer"
            onclick={() => removeGroup(group.id)}
          >{language.moduleSandboxGroups.remove}</button>
        </div>

        <div class="border-b border-darkborderc p-3">
          <div class="mb-1 text-xs text-textcolor2">
            {language.moduleSandboxGroups.modelShort}
          </div>
          <ModelList
            value={group.subModel}
            onChange={(value) =>
              moduleStore.updateSandboxGroup(group.id, { subModel: value })}
            blankable
            noneText={language.moduleSandboxGroups.defaultShort}
            noMargin
          />
        </div>

        <div class="flex flex-col gap-2 p-3">
          {#each group.members as member (member.instanceId)}
            <div class="flex min-h-10 items-center gap-2 rounded-md border border-darkborderc bg-selected/30 px-3 py-2">
              <span class="min-w-0 grow truncate text-sm font-medium">
                {moduleName(member.moduleId)}
              </span>
              <button
                type="button"
                class="shrink-0 rounded px-2 py-1 text-xs text-textcolor2 hover:bg-textcolor/10 hover:text-draculared cursor-pointer"
                onclick={() =>
                  moduleStore.removeModuleFromSandbox(
                    group.id,
                    member.instanceId,
                  )}
              >{language.moduleSandboxGroups.remove}</button>
            </div>
          {/each}
        </div>

        <div class="flex gap-2 border-t border-darkborderc p-3">
          <select
            aria-label={language.modules}
            class="min-w-0 grow rounded-md border border-darkborderc bg-darkbutton px-2 py-2 text-sm"
            value={moduleChoice[group.id] ?? ""}
            onchange={(event) =>
              (moduleChoice[group.id] = event.currentTarget.value)}
          >
            <option value="">{language.modules}</option>
            {#each modules.filter((module) => !group.members.some((member) => member.moduleId === module.id)) as module (module.id)}
              <option value={module.id}>{module.name}</option>
            {/each}
          </select>
          <button
            type="button"
            disabled={!moduleChoice[group.id]}
            class="rounded-md border border-darkborderc bg-darkbutton px-3 py-2 text-sm hover:bg-selected disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
            onclick={() => addModule(group.id)}
          >{language.moduleSandboxGroups.add}</button>
        </div>
      </section>
    {/each}
  </div>
</div>
