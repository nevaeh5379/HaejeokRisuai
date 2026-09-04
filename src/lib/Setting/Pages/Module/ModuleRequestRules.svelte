<script lang="ts">
  import { language } from "src/lang";
  import type { RisuModule } from "src/ts/process/modules";
  import { moduleStore } from "src/ts/stores/domain/moduleStore.svelte";
  import { resolveModuleRequestRules, type ModuleRequestRule, type ModuleRuleDecision } from "src/ts/process/moduleRequestRules";
  import { capturedModuleRequests, moduleRequestCaptureEnabled, recentModuleRuleDecisions, setModuleRequestCapture, clearModuleRequestCapture, type CapturedModuleRequest } from "src/ts/process/moduleRequestCapture";

  let { currentModule = $bindable() }: { currentModule: RisuModule } = $props();
  let selectedText = $state("");
  let selectedRequestId = $state<number>();
  let selectedRole = $state<ModuleRequestRule["role"]>();
  const fieldClass = "w-full rounded border border-darkborderc bg-darkbg p-2 text-textcolor";
  const buttonClass = "rounded border border-darkborderc bg-darkbutton px-3 py-2 text-textcolor disabled:opacity-40";

  function addRule(phrases: string[] = [], sourceModuleId?: string, role?: ModuleRequestRule["role"]) {
    currentModule.subModelRequestRules = [...(currentModule.subModelRequestRules ?? []), { enabled: true, phrases, sourceModuleId, role }];
  }

  function updateRule(index: number, update: Partial<ModuleRequestRule>) {
    currentModule.subModelRequestRules = currentModule.subModelRequestRules?.map((rule, i) => i === index ? { ...rule, ...update } : rule);
  }

  function moduleName(id?: string) {
    return moduleStore.list.find((module) => module.id === id)?.name ?? id ?? language.moduleRequestRules.anySource;
  }

  function decisionText(decision: ModuleRuleDecision) {
    const text = language.moduleRequestRules;
    return decision.status === "matched"
      ? `${text.matched}: ${decision.modules.map((module) => module.name).join(", ")}`
      : decision.status === "conflict"
        ? `${text.conflict}: ${decision.modules.map((module) => module.name).join(", ")}`
        : text.unmatched;
  }

  function preview(request: CapturedModuleRequest) {
    const modules = moduleStore.list.filter((module) => request.activeModuleIds.includes(module.id) && module.id !== currentModule.id);
    if (request.activeModuleIds.includes(currentModule.id)) modules.push(currentModule);
    return resolveModuleRequestRules(modules, request.messages, request.sourceModuleId);
  }

  function rememberSelection(event: Event, requestId: number, role: string) {
    const target = event.currentTarget as HTMLTextAreaElement;
    selectedText = target.value.slice(target.selectionStart, target.selectionEnd);
    selectedRequestId = requestId;
    selectedRole = role === "user" || role === "assistant" || role === "system" ? role : undefined;
  }
</script>

<section class="mt-4 flex flex-col gap-3 rounded border border-darkborderc p-3">
  <h3 class="font-bold">{language.moduleRequestRules.title}</h3>
  <p class="text-sm text-textcolor2">{language.moduleRequestRules.description}</p>
  {#if !currentModule.subModel}<p class="text-sm text-draculared">{language.moduleRequestRules.noModel}</p>{/if}
  {#each currentModule.subModelRequestRules ?? [] as rule, index}
    <div class="flex flex-col gap-3 rounded border border-darkborderc p-3">
      <div class="flex items-center justify-between gap-2">
        <label class="flex items-center gap-2"><input type="checkbox" checked={rule.enabled} onchange={(event) => updateRule(index, { enabled: event.currentTarget.checked })} />{language.moduleRequestRules.enabled} #{index + 1}</label>
        <button class={buttonClass} onclick={() => { currentModule.subModelRequestRules = currentModule.subModelRequestRules?.filter((_, i) => i !== index); }}>{language.moduleRequestRules.remove}</button>
      </div>
      <label>{language.moduleRequestRules.phrases}
        <textarea class={fieldClass} rows="3" value={(rule.phrases ?? []).join("\n")} oninput={(event) => updateRule(index, { phrases: event.currentTarget.value.split(/\r?\n/) })}></textarea>
      </label>
      <p class="text-sm text-textcolor2">{language.moduleRequestRules.phrasesHelp}</p>
      <label>{language.moduleRequestRules.source}
        <select class={fieldClass} value={rule.sourceModuleId ?? ""} onchange={(event) => updateRule(index, { sourceModuleId: event.currentTarget.value || undefined })}>
          <option value="">{language.moduleRequestRules.anySource}</option>
          {#if rule.sourceModuleId && !moduleStore.list.some((module) => module.id === rule.sourceModuleId)}<option value={rule.sourceModuleId}>{language.moduleRequestRules.missingSource}: {rule.sourceModuleId}</option>{/if}
          {#each moduleStore.list as module (module.id)}<option value={module.id}>{module.name}</option>{/each}
        </select>
      </label>
      <details>
        <summary class="cursor-pointer">{language.moduleRequestRules.advanced}</summary>
        <div class="mt-2 flex flex-col gap-2">
          <label>{language.moduleRequestRules.role}
            <select class={fieldClass} value={rule.role ?? ""} onchange={(event) => updateRule(index, { role: (event.currentTarget.value || undefined) as ModuleRequestRule["role"] })}>
              <option value="">{language.moduleRequestRules.anyRole}</option>
              <option value="user">user</option><option value="assistant">assistant</option><option value="system">system</option>
            </select>
          </label>
          <label>{language.moduleRequestRules.tail}
            <input class={fieldClass} type="number" min="1" step="1" value={rule.lastMessages ?? ""} oninput={(event) => updateRule(index, { lastMessages: event.currentTarget.value === "" ? undefined : Number(event.currentTarget.value) })} />
          </label>
          <p class="text-sm text-textcolor2">{language.moduleRequestRules.tailHelp}</p>
        </div>
      </details>
    </div>
  {/each}
  <button class={buttonClass} onclick={() => addRule()}>{language.moduleRequestRules.add}</button>
  <p class="text-sm text-textcolor2">{language.moduleRequestRules.fallbackHelp}</p>

  <details>
    <summary class="cursor-pointer">{language.moduleRequestRules.recent}</summary>
    {#each $recentModuleRuleDecisions as entry}
      <div class="mt-2 rounded border border-darkborderc p-2 text-sm">
        <div>{language.moduleRequestRules.source}: {moduleName(entry.sourceModuleId)}</div>
        <div>{decisionText(entry.decision)}</div>
        <div>→ {entry.selectedModel || language.moduleRequestRules.existing}</div>
      </div>
    {:else}<p class="mt-2 text-sm text-textcolor2">{language.moduleRequestRules.noRecent}</p>{/each}
  </details>

  <div class="flex flex-wrap gap-2">
    <button class={buttonClass} onclick={() => setModuleRequestCapture(!$moduleRequestCaptureEnabled)}>{$moduleRequestCaptureEnabled ? language.moduleRequestRules.stop : language.moduleRequestRules.capture}</button>
    <button class={buttonClass} onclick={() => { clearModuleRequestCapture(); selectedText = ""; }}>{language.moduleRequestRules.clear}</button>
  </div>
  <p class="text-sm text-textcolor2">{language.moduleRequestRules.captureHelp}</p>
  {#if $capturedModuleRequests.length}
    <h4 class="font-bold">{language.moduleRequestRules.prompts}</h4>
    <p class="text-sm text-textcolor2">{language.moduleRequestRules.selectionHelp}</p>
  {/if}
  {#each $capturedModuleRequests as request (request.id)}
    <details>
      <summary class="cursor-pointer">#{request.id} · {moduleName(request.sourceModuleId)} · {decisionText(request.decision)}</summary>
      <div class="mt-2 flex flex-col gap-2">
        {#if request.truncated}
          <p class="text-sm text-textcolor2">{language.moduleRequestRules.truncated}</p>
        {:else}
          {@const result = preview(request)}
          <p class="text-sm" aria-live="polite">{language.moduleRequestRules.preview}: {decisionText(result)} {result.model ? `→ ${result.model}` : ""}</p>
        {/if}
        {#if !request.activeModuleIds.includes(currentModule.id)}<p class="text-sm text-textcolor2">{language.moduleRequestRules.inactive}</p>{/if}
        {#each request.messages as message, index}
          <label class="text-sm">#{index + 1} · {message.role}
            <textarea class={fieldClass} readonly rows="4" value={message.content} onselect={(event) => rememberSelection(event, request.id, message.role)}></textarea>
          </label>
        {/each}
        <button class={buttonClass} disabled={selectedRequestId !== request.id || !selectedText.trim()} onclick={() => { addRule(selectedText.split(/\r?\n/), request.sourceModuleId, selectedRole); selectedText = ""; }}>{language.moduleRequestRules.fromSelection}</button>
      </div>
    </details>
  {/each}
</section>
