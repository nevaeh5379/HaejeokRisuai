import { alertError } from "../alert";
import { notifyChatResponse } from "../chatNotifications";
import { isNodeServer } from "../platform";
import { getSqlStorage } from "../storage/sql/sqlStorageFactory";
import { NodeSqlStorage } from "../storage/sql/postgres/nodeSqlStorage";
import { getNodeServerProxyAuth } from "../storage/files/nodeStorage";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { deferredSettingsLoader } from "../stores/domain/deferredSettingsLoader";
import { moduleStore } from "../stores/domain/moduleStore.svelte";
import { personaStore } from "../stores/domain/personaStore.svelte";
import { presetStore } from "../stores/domain/presetStore.svelte";
import {
  PRESET_STORE_SETTING_KEYS,
  SETTINGS_STORE_EXCLUDED_KEYS,
  getSqlDeferredDomain,
} from "../storage/sql/sqlDeferredSettings";
import { createPresetSettingsState } from "../storage/presets/presetService";
import { recoverDurableModelJobs } from "./modelJobRecovery";
import { getNodeClientSessionId } from "../network/nodeClientSession";
import type { NodeApiClient } from "@risuai/storage-remote/nodeApiClient";
import { getActiveStorageRuntime } from "../storage/runtime/activeStorageRuntime";
import {
  isLocalChatGenerationActive,
  setRemoteChatGeneration,
} from "./chatRuntimeState";
import {
  NodeRealtimeChangeQueue,
  type DatabaseChangeEvent,
} from "./nodeRealtimeChangeQueue";

type ModelJobEvent = {
  phase?: "created" | "terminal";
  sourceClientId?: string | null;
  job?: {
    id?: string;
    chatId?: string;
    generationId?: string | null;
    recoverable?: boolean;
    status?: string;
  };
};

type GenerationStateEvent = {
  chatId?: string;
  lifecycleId?: string;
  state?: "started" | "finished" | "failed" | "aborted";
  sourceClientId?: string | null;
  error?: string;
};

type ReadyEvent = {
  activeGenerations?: GenerationStateEvent[];
};

let started = false;
let streamController: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastEventId: number | null = null;
let resyncReloadScheduled = false;
let databaseChangeQueue: NodeRealtimeChangeQueue | null = null;
const activeModelJobsByChat = new Map<string, string>();

const PERSONA_ROOT_KEYS = new Set([
  "personas",
  "selectedPersona",
  "username",
  "userIcon",
  "userNote",
  "personaPrompt",
]);
const MODULE_ROOT_KEYS = new Set([
  "modules",
  "enabledModules",
  "moduleFolders",
  "moduleOrder",
]);
const PRESET_ROOT_KEYS = new Set<string>([
  "activeBotPresetId",
  ...PRESET_STORE_SETTING_KEYS,
]);
const EXCLUDED_SETTINGS_KEYS = new Set<string>(SETTINGS_STORE_EXCLUDED_KEYS);

function scheduleFullResync(): void {
  if (resyncReloadScheduled) return;
  resyncReloadScheduled = true;
  queueMicrotask(() => window.location.reload());
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ];
}

async function loadSettingValues(
  storage: NodeSqlStorage,
  keys: readonly string[],
): Promise<Map<string, unknown>> {
  const values = new Map<string, unknown>();
  for (let offset = 0; offset < keys.length; offset += 4) {
    const batch = keys.slice(offset, offset + 4);
    const loaded = await Promise.all(
      batch.map(
        async (key) => [key, await storage.loadSettingKey(key)] as const,
      ),
    );
    for (const [key, value] of loaded) values.set(key, value);
  }
  return values;
}

async function applyDatabaseChange(
  storage: NodeSqlStorage,
  change: DatabaseChangeEvent,
): Promise<void> {
  if (change.replaceAll) {
    scheduleFullResync();
    return;
  }

  const characterIds = uniqueStrings(change.characterIds ?? []);
  const chatIds = uniqueStrings(change.chatIds ?? []);
  const rootUpsertKeys = uniqueStrings(change.rootUpsertKeys ?? []);
  const rootDeleteKeys = uniqueStrings(change.rootDeleteKeys ?? []);
  const rootKeys = uniqueStrings([...rootUpsertKeys, ...rootDeleteKeys]);
  const pluginStorageUpsertKeys = uniqueStrings(
    change.pluginStorageUpsertKeys ?? [],
  );
  const pluginStorageDeleteKeys = uniqueStrings(
    change.pluginStorageDeleteKeys ?? [],
  );

  const personaChanged = rootKeys.some((key) => PERSONA_ROOT_KEYS.has(key));
  const modulesChanged =
    change.modulesChanged || rootKeys.some((key) => MODULE_ROOT_KEYS.has(key));
  const presetsChanged =
    change.presetsChanged || rootKeys.some((key) => PRESET_ROOT_KEYS.has(key));
  const deferredKeys = rootKeys.filter(
    (key) => getSqlDeferredDomain(key) !== null && !PRESET_ROOT_KEYS.has(key),
  );
  const regularUpsertKeys = rootUpsertKeys.filter(
    (key) =>
      !EXCLUDED_SETTINGS_KEYS.has(key) &&
      !PRESET_ROOT_KEYS.has(key) &&
      getSqlDeferredDomain(key) === null &&
      deferredSettingsLoader.isLoaded(key),
  );
  const regularDeleteKeys = rootDeleteKeys.filter(
    (key) =>
      !EXCLUDED_SETTINGS_KEYS.has(key) &&
      !PRESET_ROOT_KEYS.has(key) &&
      getSqlDeferredDomain(key) === null &&
      deferredSettingsLoader.isLoaded(key),
  );

  if (
    change.rootChanged &&
    rootKeys.length === 0 &&
    !personaChanged &&
    !modulesChanged &&
    !presetsChanged
  ) {
    scheduleFullResync();
    return;
  }

  const rootValues = await loadSettingValues(storage, regularUpsertKeys);
  for (const [key, value] of rootValues) {
    settingsStore.hydrateRemoteSettingKey(key, value, value !== undefined);
  }
  for (const key of regularDeleteKeys) {
    settingsStore.hydrateRemoteSettingKey(key, undefined, false);
  }
  await deferredSettingsLoader.refreshLoadedKeys(deferredKeys);

  if (change.pluginStorageCleared) {
    settingsStore.hydrateRemotePluginCustomStorageClear();
  }
  for (const key of pluginStorageDeleteKeys) {
    settingsStore.hydrateRemotePluginCustomStorageDelete(key);
  }
  for (let offset = 0; offset < pluginStorageUpsertKeys.length; offset += 4) {
    const keys = pluginStorageUpsertKeys.slice(offset, offset + 4);
    const pluginStorageValues = await Promise.all(
      keys.map(
        async (key) =>
          [key, await storage.loadPluginCustomStorageKey(key)] as const,
      ),
    );
    for (const [key, value] of pluginStorageValues) {
      if (value === undefined)
        settingsStore.hydrateRemotePluginCustomStorageDelete(key);
      else settingsStore.hydrateRemotePluginCustomStorageKey(key, value);
    }
  }

  // Domain refreshes stay sequential so large persona/module/preset documents
  // are never decoded at the same time on low-memory Android devices.
  if (personaChanged) await personaStore.refreshFromStorage();
  if (modulesChanged) await moduleStore.refreshFromStorage();
  if (presetsChanged) {
    const activePreset = await presetStore.refreshFromStorage();
    if (activePreset) {
      presetStore.replaceActivePresetState(
        createPresetSettingsState(
          {
            ...settingsStore.getStateRecord(),
            ...presetStore.getStateRecord(),
          },
          activePreset,
        ),
      );
    }
  }

  if (
    change.pluginsChanged ||
    change.action === "plugin-toggle" ||
    rootKeys.includes("plugins")
  ) {
    const { loadPlugins } = await import("../plugins/plugins.svelte");
    await loadPlugins();
  }

  const characterIndexChanged =
    change.charactersChanged ?? characterIds.length > 0;
  if (characterIndexChanged) {
    await characterStore.refreshRemoteCharacters(characterIds);
  }

  await characterStore.flush();
  if (characterStore.hasPendingWrites()) {
    throw new Error("Cannot refresh chats while local changes are pending");
  }
  const refreshableChatIds = chatIds.filter(
    (chatId) => !isLocalChatGenerationActive(chatId),
  );
  for (let offset = 0; offset < refreshableChatIds.length; offset += 2) {
    await Promise.all(
      refreshableChatIds
        .slice(offset, offset + 2)
        .map((chatId) => characterStore.refreshChat(chatId)),
    );
  }
}

async function applyModelJob(event: ModelJobEvent): Promise<void> {
  const job = event.job;
  if (!job?.chatId || job.recoverable === false) return;
  if (event.phase === "created" && job.id) {
    activeModelJobsByChat.set(job.chatId, job.id);
  } else if (
    event.phase === "terminal" &&
    (!job.id || activeModelJobsByChat.get(job.chatId) === job.id)
  ) {
    activeModelJobsByChat.delete(job.chatId);
  }
  const ownClient = event.sourceClientId === getNodeClientSessionId();
  if (ownClient) {
    // The local stream pipeline usually delivers the result itself, but on
    // mobile the page can be suspended before that happens. The server-side
    // job finishing while we are hidden is the only reliable "response is
    // ready" signal in that case, so fire the completion alarm here.
    if (
      event.phase === "terminal" &&
      job.status === "done" &&
      document.visibilityState !== "visible"
    ) {
      void notifyChatResponse({
        chatId: job.chatId,
        // The SW records the server push under the job's generationId, so
        // the dedupe key must use that id — not the job id.
        dedupeKey: `model-job:${job.generationId || job.id || job.chatId}`,
      });
    }
    return;
  }
  const source = `model-job:${job.id ?? job.chatId}`;
  setRemoteChatGeneration(job.chatId, event.phase === "created", source);
  void recoverDurableModelJobs();
}

function applyGenerationState(event: GenerationStateEvent): void {
  if (!event.chatId || !event.lifecycleId || !event.state) return;
  if (event.sourceClientId === getNodeClientSessionId()) return;
  setRemoteChatGeneration(
    event.chatId,
    event.state === "started",
    `lifecycle:${event.lifecycleId}`,
  );
  if (event.state === "finished") {
    void notifyChatResponse({
      chatId: event.chatId,
      dedupeKey: `remote:${event.lifecycleId}`,
    });
  }
  if (
    event.state === "failed" &&
    event.error &&
    !settingsStore.state.inlayErrorResponse &&
    characterStore.currentChat?.id === event.chatId
  ) {
    alertError(event.error);
  }
}

function applyReadyEvent(event: ReadyEvent): void {
  for (const generation of event.activeGenerations ?? []) {
    applyGenerationState({ ...generation, state: "started" });
  }
}

async function findActiveModelJobId(chatId: string): Promise<string | null> {
  const cached = activeModelJobsByChat.get(chatId);
  if (cached) return cached;
  try {
    const response = await fetch("/api/model-jobs?active=1", {
      headers: { "risu-auth": await getNodeServerProxyAuth() },
      cache: "no-store",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      jobs?: Array<{ id?: string; chatId?: string; recoverable?: boolean }>;
    };
    const job = body.jobs?.find(
      (item) => item.chatId === chatId && item.recoverable !== false && item.id,
    );
    if (!job?.id) return null;
    activeModelJobsByChat.set(chatId, job.id);
    return job.id;
  } catch {
    return null;
  }
}

export async function cancelNodeChatGeneration(
  chatId: string,
): Promise<boolean> {
  if (!isNodeServer || !chatId) return false;
  let jobId = await findActiveModelJobId(chatId);
  if (!jobId) return false;

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(
      `/api/model-jobs/${encodeURIComponent(jobId)}`,
      {
        method: "DELETE",
        headers: { "risu-auth": await getNodeServerProxyAuth() },
      },
    );
    if (response.ok) {
      if (activeModelJobsByChat.get(chatId) === jobId) {
        activeModelJobsByChat.delete(chatId);
      }
      const remoteSource = "model-job:" + jobId;
      setRemoteChatGeneration(chatId, false, remoteSource);
      return true;
    }
    if (response.status !== 404 || attempt > 0) return false;
    activeModelJobsByChat.delete(chatId);
    jobId = (await findActiveModelJobId(chatId)) ?? "";
    if (!jobId) return false;
  }
  return false;
}

async function dispatchEvent(
  storage: NodeSqlStorage,
  eventName: string,
  rawData: string,
  allowNodeFeatures: boolean,
): Promise<void> {
  let data: unknown;
  try {
    data = JSON.parse(rawData);
  } catch {
    return;
  }
  if (eventName === "database-change") {
    const change = data as DatabaseChangeEvent;
    if (Number.isSafeInteger(change.revision)) {
      storage.applyRemoteRevision(change.revision!);
    }
    if (change.sourceClientId !== storage.getClientId()) {
      databaseChangeQueue?.enqueue(change);
    }
    return;
  }
  if (!allowNodeFeatures) {
    if (eventName === "resync-required") scheduleFullResync();
    return;
  }
  if (eventName === "model-job") {
    await applyModelJob(data as ModelJobEvent);
  } else if (eventName === "generation-state") {
    applyGenerationState(data as GenerationStateEvent);
  } else if (eventName === "ready") {
    applyReadyEvent(data as ReadyEvent);
  } else if (eventName === "resync-required") {
    scheduleFullResync();
  }
}

async function consumeEventStream(
  response: Response,
  storage: NodeSqlStorage,
  allowNodeFeatures: boolean,
): Promise<void> {
  if (!response.body) throw new Error("Realtime event stream has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let eventName = "message";
      let frameEventId: number | null = null;
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("id:")) {
          const parsed = Number(line.slice(3).trim());
          if (Number.isSafeInteger(parsed) && parsed >= 0)
            frameEventId = parsed;
        } else if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:"))
          dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length > 0) {
        await dispatchEvent(
          storage,
          eventName,
          dataLines.join("\n"),
          allowNodeFeatures,
        );
        if (frameEventId != null) lastEventId = frameEventId;
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

function scheduleReconnect(
  storage: NodeSqlStorage,
  apiClient: NodeApiClient,
  allowNodeFeatures: boolean,
): void {
  if (!started || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect(storage, apiClient, allowNodeFeatures);
  }, 1000);
}

async function connect(
  storage: NodeSqlStorage,
  apiClient: NodeApiClient,
  allowNodeFeatures: boolean,
): Promise<void> {
  if (!started) return;
  streamController?.abort();
  const controller = new AbortController();
  streamController = controller;
  try {
    const auth = await getNodeServerProxyAuth();
    const headers: Record<string, string> = {
      "risu-auth": auth,
      "x-risu-client-id": storage.getClientId(),
    };
    if (lastEventId != null) headers["last-event-id"] = String(lastEventId);
    const response = await apiClient.request("/api/realtime/events", {
      headers,
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Realtime event stream unavailable (${response.status})`);
    }
    await consumeEventStream(response, storage, allowNodeFeatures);
  } catch (error) {
    if (!controller.signal.aborted) {
      console.warn("[NodeRealtimeSync] connection lost", error);
    }
  } finally {
    if (streamController === controller) streamController = null;
    if (!controller.signal.aborted)
      scheduleReconnect(storage, apiClient, allowNodeFeatures);
  }
}

export async function initNodeRealtimeSync(): Promise<void> {
  if (started) return;
  const storage = await getSqlStorage();
  if (!(storage instanceof NodeSqlStorage)) return;
  const runtime = getActiveStorageRuntime();
  if (!runtime.nodeApiClient) return;
  const apiClient = runtime.nodeApiClient;
  const allowNodeFeatures = isNodeServer;
  databaseChangeQueue = new NodeRealtimeChangeQueue(
    (change) => applyDatabaseChange(storage, change),
    (error) =>
      console.error("[NodeRealtimeSync] database refresh failed", error),
  );
  started = true;
  window.addEventListener("online", () => {
    if (!streamController) void connect(storage, apiClient, allowNodeFeatures);
  });
  void connect(storage, apiClient, allowNodeFeatures);
}
