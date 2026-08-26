import { isNodeServer } from "../platform";
import { getSqlStorage } from "../storage/sqlStorageFactory";
import { NodePostgresStorage } from "../storage/nodePostgresStorage";
import { getNodeServerProxyAuth } from "../storage/nodeStorage";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { recoverDurableModelJobs } from "./modelJobRecovery";
import {
  isLocalChatGenerationActive,
  setRemoteChatGeneration,
} from "./chatRuntimeState";

type DatabaseChangeEvent = {
  revision?: number;
  action?: string;
  sourceClientId?: string | null;
  chatIds?: string[];
  characterIds?: string[];
  rootChanged?: boolean;
};

type ModelJobEvent = {
  phase?: "created" | "terminal";
  job?: {
    id?: string;
    chatId?: string;
    recoverable?: boolean;
  };
};

let started = false;
let streamController: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const activeModelJobsByChat = new Map<string, string>();

async function applyDatabaseChange(
  storage: NodePostgresStorage,
  change: DatabaseChangeEvent,
): Promise<void> {
  if (Number.isSafeInteger(change.revision)) {
    storage.applyRemoteRevision(change.revision!);
  }
  if (change.sourceClientId === storage.getClientId()) return;

  const characterIds = Array.isArray(change.characterIds)
    ? [...new Set(change.characterIds.filter(Boolean))]
    : [];
  const chatIds = Array.isArray(change.chatIds)
    ? [...new Set(change.chatIds.filter(Boolean))]
    : [];

  await Promise.all(
    characterIds.map((characterId) =>
      characterStore.ensureCharacterDetails(characterId),
    ),
  );
  await Promise.all(
    chatIds
      .filter((chatId) => !isLocalChatGenerationActive(chatId))
      .map((chatId) => characterStore.refreshChat(chatId)),
  );
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
  setRemoteChatGeneration(job.chatId, event.phase === "created");
  void recoverDurableModelJobs();
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

export async function cancelNodeChatGeneration(chatId: string): Promise<boolean> {
  if (!isNodeServer || !chatId) return false;
  let jobId = await findActiveModelJobId(chatId);
  if (!jobId) return false;

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`/api/model-jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
      headers: { "risu-auth": await getNodeServerProxyAuth() },
    });
    if (response.ok) {
      if (activeModelJobsByChat.get(chatId) === jobId) {
        activeModelJobsByChat.delete(chatId);
      }
      setRemoteChatGeneration(chatId, false);
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
  storage: NodePostgresStorage,
  eventName: string,
  rawData: string,
): Promise<void> {
  let data: unknown;
  try {
    data = JSON.parse(rawData);
  } catch {
    return;
  }
  if (eventName === "database-change") {
    await applyDatabaseChange(storage, data as DatabaseChangeEvent);
  } else if (eventName === "model-job") {
    await applyModelJob(data as ModelJobEvent);
  }
}

async function consumeEventStream(
  response: Response,
  storage: NodePostgresStorage,
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
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length > 0) {
        await dispatchEvent(storage, eventName, dataLines.join("\n"));
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

function scheduleReconnect(storage: NodePostgresStorage): void {
  if (!started || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect(storage);
  }, 1000);
}

async function connect(storage: NodePostgresStorage): Promise<void> {
  if (!started) return;
  streamController?.abort();
  const controller = new AbortController();
  streamController = controller;
  try {
    const auth = await getNodeServerProxyAuth();
    const response = await fetch("/api/realtime/events", {
      headers: {
        "risu-auth": auth,
        "x-risu-client-id": storage.getClientId(),
      },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Realtime event stream unavailable (${response.status})`);
    }
    await consumeEventStream(response, storage);
  } catch (error) {
    if (!controller.signal.aborted) {
      console.warn("[NodeRealtimeSync] connection lost", error);
    }
  } finally {
    if (streamController === controller) streamController = null;
    if (!controller.signal.aborted) scheduleReconnect(storage);
  }
}

export async function initNodeRealtimeSync(): Promise<void> {
  if (!isNodeServer || started) return;
  const storage = await getSqlStorage();
  if (!(storage instanceof NodePostgresStorage)) return;
  started = true;
  window.addEventListener("online", () => {
    if (!streamController) void connect(storage);
  });
  void connect(storage);
}
