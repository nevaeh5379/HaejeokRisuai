import type { RealtimeDatabaseChangeEvent } from "../../../packages/protocol/realtimeEvents.cjs";

/**
 * Canonical wire shape of a database-change realtime event, shared with the
 * server through the protocol package.
 * 서버와 프로토콜 패키지를 통해 공유하는 database-change 실시간 이벤트의
 * 표준 와이어 형태입니다.
 */
export type DatabaseChangeEvent = RealtimeDatabaseChangeEvent;

const ARRAY_FIELDS = [
  "chatIds",
  "characterIds",
  "rootUpsertKeys",
  "rootDeleteKeys",
  "pluginStorageUpsertKeys",
  "pluginStorageDeleteKeys",
] as const satisfies readonly (keyof DatabaseChangeEvent)[];

const BOOLEAN_FIELDS = [
  "replaceAll",
  "charactersChanged",
  "rootChanged",
  "pluginStorageCleared",
  "pluginsChanged",
  "presetsChanged",
  "modulesChanged",
] as const satisfies readonly (keyof DatabaseChangeEvent)[];

function mergeStringArrays(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): string[] | undefined {
  if (!left?.length && !right?.length) return undefined;
  return [...new Set([...(left ?? []), ...(right ?? [])].filter(Boolean))];
}

/**
 * Mutable working copy of the canonical wire type: the wire payload is
 * readonly, but the queue assembles merged events field by field.
 * 표준 와이어 타입의 가변 작업 사본입니다. 와이어 페이로드는 불변이지만,
 * 큐는 병합된 이벤트를 필드 단위로 조립합니다.
 */
type MutableDatabaseChangeEvent = {
  -readonly [K in keyof DatabaseChangeEvent]: DatabaseChangeEvent[K];
};

/**
 * Combines a burst of database notifications without retaining commit
 * payloads. The newest scalar authority wins while affected IDs/keys form a
 * set, keeping realtime memory proportional to the touched records only.
 */
export function mergeDatabaseChanges(
  current: DatabaseChangeEvent | null,
  incoming: DatabaseChangeEvent,
): DatabaseChangeEvent {
  const merged: MutableDatabaseChangeEvent = current ? { ...current } : {};
  for (const field of ARRAY_FIELDS) {
    const value = mergeStringArrays(
      merged[field] as readonly string[] | undefined,
      incoming[field] as readonly string[] | undefined,
    );
    if (value) (merged[field] as string[]) = value;
  }
  for (const field of BOOLEAN_FIELDS) {
    if (current?.[field] !== undefined || incoming[field] !== undefined) {
      (merged[field] as boolean) = Boolean(current?.[field] || incoming[field]);
    }
  }

  if (Number.isSafeInteger(incoming.revision)) {
    merged.revision = Math.max(merged.revision ?? 0, incoming.revision!);
  }
  if (incoming.action === "plugin-toggle") merged.pluginsChanged = true;
  return merged;
}

/** Serial, coalescing queue for SSE database changes. */
export class NodeRealtimeChangeQueue {
  private pending: DatabaseChangeEvent | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private draining: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly apply: (change: DatabaseChangeEvent) => Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly coalesceMs = 40,
    private readonly retryMs = 1_000,
  ) {}

  enqueue(change: DatabaseChangeEvent): void {
    if (this.closed) return;
    this.pending = mergeDatabaseChanges(this.pending, change);
    if (this.timer || this.draining) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, this.coalesceMs);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.drain();
  }

  close(): void {
    this.closed = true;
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      await this.draining;
      if (this.pending && !this.closed) await this.drain();
      return;
    }
    this.draining = (async () => {
      while (this.pending && !this.closed) {
        const change = this.pending;
        this.pending = null;
        try {
          await this.apply(change);
        } catch (error) {
          this.pending = mergeDatabaseChanges(change, this.pending ?? {});
          this.onError(error);
          break;
        }
      }
    })().finally(() => {
      this.draining = null;
      if (this.pending && !this.closed && !this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.drain();
        }, this.retryMs);
      }
    });
    await this.draining;
  }
}
