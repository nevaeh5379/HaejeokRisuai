<script lang="ts">
  import { language } from "src/lang";
  import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
  import { globalFetch } from "src/ts/globalApi.svelte";
  import {
    fetchComfyWorkflowJson,
    withComfyWorkflowTimeout,
    COMFY_WORKFLOW_LIST_PATH,
    parseComfyWorkflowList,
    fetchComfyWorkflowObjectInfo,
  } from "src/ts/process/comfyWorkflowRequest";
  import { selectSingleFile } from "src/ts/util";
  import { alertConfirm, alertNormal } from "src/ts/alert";
  import {
    createComfyUrlBuilder,
    type ComfyWorkflow,
  } from "@risuai/protocol/dist/imageGeneration.mjs";
  import TextInput from "src/lib/UI/GUI/TextInput.svelte";
  import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
  import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";

  const config = $derived(settingsStore.state.comfyConfig);
  const workflows = $derived(config.workflows ?? []);
  const selected = $derived(
    workflows.find((item) => item.id === config.selectedWorkflowId) ??
      workflows[0],
  );
  let busy = $state(false);
  let serverFiles = $state<string[]>([]);
  let serverFile = $state("");
  let listed = $state(false);
  let error = $state("");
  let phase = $state("");
  $effect(() => {
    // Changing servers invalidates the previously fetched file list.
    settingsStore.state.comfyUiUrl;
    serverFiles = [];
    serverFile = "";
    listed = false;
    error = "";
  });
  const buttonClass =
    "rounded-md border border-darkborderc px-3 py-2 text-sm text-textcolor hover:bg-textcolor/5 disabled:opacity-50";

  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = "";
    phase = language.comfyWorkflows.working;
    try {
      await action();
    } catch (cause) {
      error = `${phase}\n${cause instanceof Error ? cause.message : String(cause)}`;
    } finally {
      busy = false;
      phase = "";
    }
  }
  async function getJson(path: string, url: string) {
    return fetchComfyWorkflowJson(
      createComfyUrlBuilder(url)(path),
      globalFetch,
      language.comfyWorkflows.requestTimeout,
    );
  }
  async function prepare(value: unknown, url: string) {
    phase = language.comfyWorkflows.converting;
    const { readApiWorkflow, convertComfyWorkflow } =
      await withComfyWorkflowTimeout(
        () => import("src/ts/process/comfyWorkflow"),
        language.comfyWorkflows.requestTimeout,
      );
    const api = readApiWorkflow(value);
    if (api) return JSON.stringify(api, null, 2);
    phase = language.comfyWorkflows.loadingNodes;
    const info = await fetchComfyWorkflowObjectInfo(
      value,
      (path) => getJson(path, url),
      createComfyUrlBuilder(url),
      (completed, total) => {
        phase = `${language.comfyWorkflows.loadingNodes} (${completed}/${total})`;
      },
    );
    phase = language.comfyWorkflows.converting;
    return JSON.stringify(
      await withComfyWorkflowTimeout(
        () => convertComfyWorkflow(value, info),
        language.comfyWorkflows.requestTimeout,
      ),
      null,
      2,
    );
  }
  function add(name = "Workflow", workflow = "") {
    const item: ComfyWorkflow = { id: crypto.randomUUID(), name, workflow };
    config.workflows = [...workflows, item];
    config.selectedWorkflowId = item.id;
  }
  async function importFile() {
    const file = await selectSingleFile(["json"]);
    if (!file) return;
    phase = language.comfyWorkflows.loadingWorkflow;
    const workflow = await prepare(
      JSON.parse(new TextDecoder().decode(file.data)),
      settingsStore.state.comfyUiUrl,
    );
    add(file.name.replace(/\.json$/i, ""), workflow);
  }
  async function listServer() {
    phase = language.comfyWorkflows.loadingList;
    const url = settingsStore.state.comfyUiUrl;
    const files = await getJson(COMFY_WORKFLOW_LIST_PATH, url);
    if (url !== settingsStore.state.comfyUiUrl) return;
    serverFiles = parseComfyWorkflowList(
      files,
      createComfyUrlBuilder(url)(COMFY_WORKFLOW_LIST_PATH),
    );
    serverFile = serverFiles[0] ?? "";
    listed = true;
  }
  async function importServer() {
    phase = language.comfyWorkflows.loadingWorkflow;
    const file = serverFile;
    const url = settingsStore.state.comfyUiUrl;
    const value = await getJson(
      `/userdata/${encodeURIComponent(`workflows/${file}`)}`,
      url,
    );
    const workflow = await prepare(value, url);
    add(file.replace(/\.json$/i, ""), workflow);
  }
  async function convertSelected() {
    const item = selected;
    if (!item) return;
    const original = item.workflow;
    const workflow = await prepare(
      JSON.parse(original),
      settingsStore.state.comfyUiUrl,
    );
    if (
      item.workflow !== original ||
      !workflows.some((entry) => entry.id === item.id)
    )
      return;
    item.workflow = workflow;
    alertNormal(language.comfyWorkflows.converted);
  }
  async function removeSelected() {
    const id = selected?.id;
    if (!id || !(await alertConfirm(language.comfyWorkflows.removeConfirm)))
      return;
    config.workflows = workflows.filter((item) => item.id !== id);
    config.selectedWorkflowId = config.workflows[0]?.id ?? "";
    config.workflow = "";
  }
</script>

<div class="flex flex-col gap-2 mb-4">
  <span class="text-textcolor">{language.comfyWorkflows.saved}</span>
  {#if selected}
    <SelectInput size="sm" value={selected.id} disabled={busy} onchange={(event) => config.selectedWorkflowId = event.currentTarget.value}>
      {#each workflows as item (item.id)}
        <OptionInput value={item.id}>{item.name}</OptionInput>
      {/each}
    </SelectInput>
    <span class="text-textcolor">{language.comfyWorkflows.name}</span>
    <TextInput size="sm" bind:value={selected.name} />
    {#key selected.id}
      {#await withComfyWorkflowTimeout(() => import("./ComfyWorkflowJson.svelte"), language.comfyWorkflows.requestTimeout)}
        <p class="text-sm text-textcolor2" role="status">{language.comfyWorkflows.loadingViewer}</p>
      {:then viewer}
        <viewer.default bind:workflow={selected.workflow} />
      {:catch cause}
        <p class="text-sm text-draculared" role="alert">{String(cause)}</p>
      {/await}
    {/key}
  {/if}
  <div class="flex flex-wrap gap-2">
    <button class={buttonClass} disabled={busy} onclick={() => add()}>{language.comfyWorkflows.add}</button>
    <button class={buttonClass} disabled={busy} onclick={() => run(importFile)}>{language.comfyWorkflows.importFile}</button>
    {#if selected}
      <button class={buttonClass} disabled={busy} onclick={() => run(convertSelected)}>{language.comfyWorkflows.convert}</button>
      <button class={buttonClass} disabled={busy} onclick={() => run(removeSelected)}>{language.comfyWorkflows.remove}</button>
    {/if}
  </div>
  <p class="text-xs text-textcolor2">{language.comfyWorkflows.help}</p>
  <button class={buttonClass} disabled={busy} onclick={() => run(listServer)}>{language.comfyWorkflows.load}</button>
  {#if serverFiles.length}
    <SelectInput size="sm" bind:value={serverFile} disabled={busy}>
      {#each serverFiles as file}<OptionInput value={file}>{file}</OptionInput>{/each}
    </SelectInput>
    <button class={buttonClass} disabled={busy || !serverFile} onclick={() => run(importServer)}>{language.comfyWorkflows.importServer}</button>
  {:else if listed}
    <p class="text-xs text-textcolor2" role="status">{language.comfyWorkflows.empty}</p>
  {/if}
  {#if busy}<p class="text-sm text-textcolor2" role="status">{phase}</p>{/if}
  {#if error}<p class="text-sm text-draculared break-words whitespace-pre-wrap" role="alert">{error}</p>{/if}
</div>
