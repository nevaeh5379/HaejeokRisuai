import { isNodeServer } from "../platform";
import { getNodeClientSessionId } from "../network/nodeClientSession";
import { getNodeServerProxyAuth } from "../storage/files/nodeStorage";

type GenerationLifecycleState = "started" | "finished" | "failed" | "aborted";

const activeLifecycles = new Map<string, string>();
const failedLifecycles = new Set<string>();

function createLifecycleId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

async function publishState(
  chatId: string,
  lifecycleId: string,
  state: GenerationLifecycleState,
  error?: string,
): Promise<void> {
  if (!isNodeServer || !chatId || !lifecycleId) return;
  try {
    await fetch("/api/realtime/generation-state", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "risu-auth": await getNodeServerProxyAuth(),
        "x-risu-client-id": getNodeClientSessionId(),
      },
      body: JSON.stringify({ chatId, lifecycleId, state, error }),
      cache: "no-store",
    });
  } catch (caught) {
    console.warn("[NodeGenerationLifecycle] state publish failed", caught);
  }
}

export async function beginNodeGenerationLifecycle(
  chatId: string,
): Promise<string | null> {
  if (!isNodeServer || !chatId) return null;
  const lifecycleId = createLifecycleId();
  activeLifecycles.set(chatId, lifecycleId);
  await publishState(chatId, lifecycleId, "started");
  return lifecycleId;
}

export function reportNodeGenerationFailure(
  chatId: string | undefined,
  error: unknown,
): void {
  if (!chatId) return;
  const lifecycleId = activeLifecycles.get(chatId);
  if (!lifecycleId || failedLifecycles.has(lifecycleId)) return;
  failedLifecycles.add(lifecycleId);
  const message = error instanceof Error ? error.message : String(error);
  void publishState(chatId, lifecycleId, "failed", message);
}

export async function endNodeGenerationLifecycle(
  chatId: string,
  lifecycleId: string | null,
  aborted = false,
): Promise<void> {
  if (!chatId || !lifecycleId) return;
  if (activeLifecycles.get(chatId) === lifecycleId) {
    activeLifecycles.delete(chatId);
  }
  if (failedLifecycles.delete(lifecycleId)) return;
  await publishState(chatId, lifecycleId, aborted ? "aborted" : "finished");
}
