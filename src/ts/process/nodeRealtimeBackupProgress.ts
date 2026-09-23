import type { RealtimeLocalBackupImportProgressEvent } from "@risuai/protocol/realtimeEvents.cjs";

type Listener = (event: RealtimeLocalBackupImportProgressEvent) => void;

const listeners = new Map<string, Set<Listener>>();
let connected = false;

export function setNodeRealtimeConnected(value: boolean): void {
  connected = value;
}

export function isNodeRealtimeConnected(): boolean {
  return connected;
}

export function publishNodeBackupProgress(
  event: RealtimeLocalBackupImportProgressEvent,
): void {
  for (const listener of listeners.get(event.jobId) ?? []) {
    try {
      listener(event);
    } catch (error) {
      console.error(
        "[NodeRealtimeSync] backup progress listener failed",
        error,
      );
    }
  }
}

export function subscribeNodeBackupProgress(
  jobId: string,
  listener: Listener,
): () => void {
  const jobListeners = listeners.get(jobId) ?? new Set<Listener>();
  jobListeners.add(listener);
  listeners.set(jobId, jobListeners);
  return () => {
    jobListeners.delete(listener);
    if (jobListeners.size === 0) listeners.delete(jobId);
  };
}
