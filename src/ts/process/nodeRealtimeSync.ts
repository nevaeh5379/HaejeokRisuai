import { alertError } from "../alert";
import { chatTabsStore } from "../chatTabs.svelte";
import { changeLanguage } from "../../lang";
import { notifyChatResponse } from "../chatNotifications";
import { applyStartupAppearance } from "../bootstrap/appAppearance";
import { initPresetDomain } from "../bootstrap/presetStartup";
import { initRuntimeSettings } from "../bootstrap/runtimeSettings";
import { isCapacitor, isNodeServer, isTauri } from "../platform";
import { installStartupData } from "../storage/database/databaseLifecycle";
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
import { consumeNodeRealtimeWebSocket } from "./nodeRealtimeWebSocket";
import {
  parseRealtimeEvent,
  type GenerationLifecycleState,
  type RealtimeDatabaseChangeEvent,
  type RealtimeGenerationState,
  type RealtimeModelJobEvent,
  type RealtimeReadyEvent,
} from "../../../packages/protocol/realtimeEvents.cjs";

let started = false;
let streamController: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastEventId: number | null = null;
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
  "moduleSandboxGroups",
]);
const PRESET_ROOT_KEYS = new Set<string>([
  "activeBotPresetId",
  ...PRESET_STORE_SETTING_KEYS,
]);
const EXCLUDED_SETTINGS_KEYS = new Set<string>(SETTINGS_STORE_EXCLUDED_KEYS);

function pruneInvalidChatTabs(): void {
  const validTargets = new Set<string>();
  for (const character of characterStore.characters) {
    if (!character.chaId) continue;
    for (const chat of character.chats ?? []) {
      if (chat?.id) validTargets.add(`${character.chaId}\0${chat.id}`);
    }
  }
  chatTabsStore.pruneInvalidTargets((characterId, chatId) =>
    validTargets.has(`${characterId}\0${chatId}`),
  );
}

async function applyFullResync(storage: NodeSqlStorage): Promise<void> {
  const selectedCharacterId = characterStore.currentCharacter?.chaId;
  const startup = await storage.loadStartupData();
  if (!startup || startup.status !== "ready") {
    throw new Error("Cannot resync from an empty remote database");
  }

  const loadedDeferredKeys = (startup.deferredSettingKeys ?? []).filter((key) =>
    deferredSettingsLoader.isLoaded(key),
  );

  installStartupData(startup, storage);
  pruneInvalidChatTabs();
  await initPresetDomain(storage);
  await changeLanguage(settingsStore.state.language);
  await initRuntimeSettings(storage);
  for (const key of loadedDeferredKeys) {
    await deferredSettingsLoader.ensureKey(key);
  }
  applyStartupAppearance();

  const { selectedCharID } = await import("../stores.svelte");
  const selectedIndex = selectedCharacterId
    ? characterStore.characters.findIndex(
        (character) => character.chaId === selectedCharacterId,
      )
    : -1;
  selectedCharID.set(selectedIndex);
  if (selectedIndex >= 0 && selectedCharacterId) {
    await characterStore.ensureCharacterDetails(selectedCharacterId);
  }
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
    await applyFullResync(storage);
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
    await applyFullResync(storage);
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
    // Remote deletions can remove characters/chats that local chat tabs are
    // still referencing; prune those tabs so activating one can never
    // deadlock the chat screen on its loading gate.
    pruneInvalidChatTabs();
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

async function applyModelJob(event: RealtimeModelJobEvent): Promise<void> {
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

function applyGenerationState(event: RealtimeGenerationState): void {
  if (!event.chatId || !event.lifecycleId) return;
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

function applyReadyEvent(event: RealtimeReadyEvent): void {
  for (const generation of event.activeGenerations) {
    const started: RealtimeGenerationState = {
      ...generation,
      state: "started" satisfies GenerationLifecycleState,
    };
    applyGenerationState(started);
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
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawData);
  } catch {
    return;
  }
  // The SSE/WebSocket boundary is untrusted: JSON.parse results are narrowed
  // against the shared event map instead of being cast blindly.
  // SSE/WebSocket 경계는 신뢰할 수 없으므로, JSON.parse 결과를 무분별하게
  // 캐스팅하지 않고 공유 이벤트 맵으로 좁힙니다.
  const frame = parseRealtimeEvent(eventName, parsedJson);
  if (frame === null) {
    // A malformed database delta has no deletion authority. Request a full
    // refresh instead of silently leaving the local client stale.
    // 잘못된 DB 델타는 삭제 권한이 없으므로, 무시해 로컬 상태를
    // 낡은 채로 두지 않고 전체 동기화를 요청합니다.
    if (eventName === "database-change") {
      databaseChangeQueue?.enqueue({
        action: "realtime-invalid-database-change",
        replaceAll: true,
        sourceClientId: null,
      });
    }
    return;
  }
  if (frame.event === "database-change") {
    const change: RealtimeDatabaseChangeEvent = frame.data;
    if (change.revision !== undefined) {
      storage.applyRemoteRevision(change.revision);
    }
    if (change.sourceClientId !== storage.getClientId()) {
      databaseChangeQueue?.enqueue(change);
    }
    return;
  }
  if (frame.event === "model-job") {
    if (allowNodeFeatures) await applyModelJob(frame.data);
  } else if (frame.event === "generation-state") {
    applyGenerationState(frame.data);
  } else if (frame.event === "ready") {
    applyReadyEvent(frame.data);
  } else if (frame.event === "resync-required") {
    lastEventId = frame.data.latestEventId;
    databaseChangeQueue?.enqueue({
      action: "realtime-resync",
      replaceAll: true,
    });
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
    if (isTauri || isCapacitor) {
      await consumeNodeRealtimeWebSocket({
        apiClient,
        auth,
        clientId: storage.getClientId(),
        lastEventId,
        signal: controller.signal,
        onFrame: async (frame) => {
          await dispatchEvent(
            storage,
            frame.event,
            JSON.stringify(frame.data ?? null),
            allowNodeFeatures,
          );
          if (Number.isSafeInteger(frame.id) && Number(frame.id) >= 0) {
            lastEventId = Number(frame.id);
          }
        },
      });
      return;
    }
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
