import {
  cleanIllustrationTags,
  retainIllustrationImageTags,
  describeIllustrationError,
  IllustrationQueue,
  validIllustration,
  normalizeIllustrationGenerationCount,
  type Illustration,
  type IllustrationMessage,
  type IllustrationTarget,
  type IllustrationErrorStage,
} from "./illustration.ts";

/**
 * Groups the latest message, its slot and active branch for a guarded transition.
 *
 * 한국어: 상태 변경 검증에 사용할 최신 메시지·삽화 자리·활성 분기를 묶은 정보.
 */
export interface IllustrationRecord {
  message: IllustrationMessage;
  item: Illustration;
  branchId?: string;
}

/**
 * Supplies platform-specific persistence, submodel, provider and asset operations.
 *
 * 한국어: 공통 실행기에 저장·보조 모델·이미지 제공자·자산 처리 동작을 제공하는 플랫폼 계약.
 */
export interface IllustrationRuntime {
  generationCount?(target: IllustrationTarget): Promise<number>;
  tagRequestMode?(
    target: IllustrationTarget,
  ): Promise<"sequential" | "parallel">;
  /**
   * Reads, validates and persists a transition against the latest slot version.
   *
   * 한국어: 최신 삽화 버전을 읽고 검증한 뒤 상태 변경을 저장하는 함수.
   *
   * @returns The updated record, or null when invalidated. / 변경된 정보 또는 무효화 시 null.
   */
  update(
    target: IllustrationTarget,
    version: number,
    change: (record: IllustrationRecord) => void,
  ): Promise<IllustrationRecord | null>;
  /**
   * Generates scene tags using context for this specific slot.
   *
   * 한국어: 해당 삽화 자리의 장면 문맥으로 태그를 작성하는 함수.
   */
  createTags(
    target: IllustrationTarget,
    record: IllustrationRecord,
  ): Promise<string>;
  /**
   * Combines generated tags with current base and negative prompts.
   *
   * 한국어: 생성 태그와 현재 기본·네거티브 프롬프트를 조합하는 함수.
   */
  prompts(
    tags: string,
    target: IllustrationTarget,
  ): Promise<{ prompt: string; negativePrompt: string }>;
  /**
   * Requests image data from the configured provider.
   *
   * 한국어: 설정된 이미지 제공자에 그림 생성을 요청하는 함수.
   */
  createImage(
    prompt: string,
    negativePrompt: string,
    target: IllustrationTarget,
  ): Promise<string>;
  /**
   * Durably stores image data before returning its inlay ID.
   *
   * 한국어: 그림 데이터를 영구 저장한 뒤 인레이 ID를 반환하는 함수.
   */
  storeImage(data: string): Promise<string>;
  /**
   * Removes a newly stored image that could not be attached to the message.
   *
   * 한국어: 메시지에 반영하지 못한 새 그림 자산을 제거하는 함수.
   */
  removeImage(id: string): Promise<void>;
  /**
   * Converts an error into a safe persisted summary without provider secrets.
   *
   * 한국어: 제공자 인증 정보를 제외한 저장용 오류 요약을 만드는 함수.
   */
  summarizeError(error: unknown): string;
}

/**
 * Encodes all stable target IDs into an unambiguous queue/context key.
 *
 * 한국어: 대상의 안정적인 ID를 모호하지 않은 큐·문맥 조회 키로 만드는 함수.
 */
export function illustrationJobKey(target: IllustrationTarget): string {
  return JSON.stringify([
    target.characterId,
    target.chatId,
    target.messageId,
    target.illustrationId,
  ]);
}

type ReadyEntry = {
  index: number;
  tags?: string;
  failure?: { error: unknown };
};

/**
 * Prefetches at most four tag requests, yielding results in arrival order.
 * Only the consumer writes SQL or generates images. The bounded completion queue holds text,
 * and exiting drains in-flight work before releasing the executor's request reservation.
 */
async function* readyBatchEntries(
  runtime: IllustrationRuntime,
  target: IllustrationTarget,
  record: IllustrationRecord,
  count: number,
  mode: "sequential" | "parallel",
): AsyncGenerator<ReadyEntry> {
  const indices = Array.from({ length: count }, (_, index) => index).filter(
    (index) => !record.item.batch!.entries[index]?.imageId,
  );
  if (mode === "sequential") {
    for (const index of indices) yield { index };
    return;
  }
  const ready: ReadyEntry[] = [];
  let next = 0;
  let stopped = false;
  let wake: (() => void) | undefined;
  const worker = async () => {
    while (!stopped && next < indices.length) {
      const index = indices[next++];
      let result: ReadyEntry;
      try {
        const tags =
          record.item.batch!.entries[index]?.tags ??
          cleanIllustrationTags(await runtime.createTags(target, record));
        result = { index, tags };
      } catch (error) {
        result = { index, failure: { error } };
      }
      if (stopped) return;
      ready.push(result);
      wake?.();
      wake = undefined;
    }
  };
  const workers = Array.from({ length: Math.min(4, indices.length) }, worker);
  try {
    for (let completed = 0; completed < indices.length; completed++) {
      if (!ready.length)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      yield ready.shift()!;
    }
  } finally {
    stopped = true;
    await Promise.allSettled(workers);
  }
}

/**
 * Creates a serial tag-to-image runner shared by the app and Node adapters.
 *
 * 한국어: 앱·Node 어댑터에서 공유하는 태그 작성부터 그림 저장까지의 순차 실행기를 만드는 함수.
 *
 * @param runtime - Platform-specific operations. / 플랫폼별 처리 동작.
 * @returns Functions to run a slot version and check pending jobs. / 특정 버전 실행·대기 작업 조회 함수.
 * @remarks
 * Reuses saved tags, validates every transition and replaces the token only after image storage.
 * Failed or stale replacement keeps the old picture; only newly orphaned assets are removed.
 * 한국어: 저장된 태그를 재사용하고 매 단계 검증 후 새 그림 저장에 성공한 경우에만 토큰을 교체.
 * 실패·무효화 시 기존 그림을 유지하며 새로 생긴 미사용 자산만 정리.
 */
export function createIllustrationRunner(runtime: IllustrationRuntime) {
  const queue = new IllustrationQueue();
  /**
   * Runs one version once, recording safe failures and releasing unattached image data.
   *
   * 한국어: 특정 버전을 중복 없이 실행하고 오류 상태 기록·미반영 그림 정리를 처리하는 함수.
   */
  const run = (target: IllustrationTarget, version: number) =>
    queue.enqueue(`${illustrationJobKey(target)}:${version}`, async () => {
      let storedId: string | undefined;
      let stage: IllustrationErrorStage = "prepare";
      try {
        let record = await runtime.update(target, version, () => {});
        if (!record) return;
        if (record.item.batch?.version !== version) {
          const count = normalizeIllustrationGenerationCount(
            (await runtime.generationCount?.(target)) ??
              record.item.batch?.count ??
              1,
          );
          record = await runtime.update(target, version, ({ item }) => {
            retainIllustrationImageTags(item);
            const previous = item.batch?.entries ?? [
              {
                tags: item.tags,
                prompt: item.prompt,
                negativePrompt: item.negativePrompt,
              },
            ];
            item.batch = {
              version,
              count,
              entries: Array.from({ length: count }, (_, index) => {
                const { tags, prompt, negativePrompt } = previous[index] ?? {};
                return { tags, prompt, negativePrompt };
              }),
            };
          });
          if (!record) return;
        }
        const count = normalizeIllustrationGenerationCount(
          record.item.batch!.count,
        );
        const mode = (await runtime.tagRequestMode?.(target)) ?? "sequential";
        if (mode === "parallel") {
          record = await runtime.update(target, version, ({ item }) => {
            item.status = "tagging";
          });
          if (!record) return;
        }
        let failure:
          { error: unknown; stage: IllustrationErrorStage } | undefined;
        for await (const ready of readyBatchEntries(
          runtime,
          target,
          record,
          count,
          mode,
        )) {
          const { index } = ready;
          stage = "prepare";
          record = await runtime.update(target, version, () => {});
          if (!record) return;
          if (record.item.batch!.entries[index]?.imageId) continue;
          try {
            if (ready.failure) {
              stage = "tags";
              throw ready.failure.error;
            }
            let entry = record.item.batch!.entries[index];
            if (!entry.tags) {
              stage = "tags";
              record = await runtime.update(target, version, ({ item }) => {
                item.status = "tagging";
              });
              if (!record) return;
              const tags = cleanIllustrationTags(
                ready.tags ?? (await runtime.createTags(target, record)),
              );
              const prompts = await runtime.prompts(tags, target);
              record = await runtime.update(target, version, ({ item }) => {
                Object.assign(item.batch!.entries[index], prompts, { tags });
              });
              if (!record) return;
              entry = record.item.batch!.entries[index];
            }
            if (!entry.prompt) {
              const prompts = await runtime.prompts(entry.tags!, target);
              record = await runtime.update(target, version, ({ item }) => {
                Object.assign(item.batch!.entries[index], prompts);
              });
              if (!record) return;
              entry = record.item.batch!.entries[index];
            }
            record = await runtime.update(target, version, ({ item }) => {
              item.status = "generating";
              Object.assign(item, {
                tags: entry.tags,
                prompt: entry.prompt,
                negativePrompt: entry.negativePrompt,
              });
              delete item.error;
              delete item.errorDetails;
            });
            if (!record) return;
            stage = "image";
            const data = await runtime.createImage(
              entry.prompt!,
              entry.negativePrompt ?? "",
              target,
            );
            if (!(await runtime.update(target, version, () => {}))) return;
            stage = "save";
            storedId = await runtime.storeImage(data);
            const completed = await runtime.update(
              target,
              version,
              ({ message, item }) => {
                const token = `{{inlay::${storedId}}}`;
                item.imageIds = [
                  ...new Set([
                    ...(item.imageIds ?? []),
                    ...(item.imageId ? [item.imageId] : []),
                    storedId!,
                  ]),
                ];
                item.batch!.entries[index].imageId = storedId;
                (item.imageTags ??= {})[storedId!] = entry.tags!;
                message.data = message.data.replace(item.token, token);
                Object.assign(item, { token, imageId: storedId });
              },
            );
            if (!completed) return;
            storedId = undefined;
          } catch (error) {
            failure = { error, stage };
          } finally {
            if (storedId) {
              await runtime.removeImage(storedId).catch(() => {});
              storedId = undefined;
            }
          }
        }
        await runtime.update(target, version, ({ item }) => {
          item.status = failure ? "failed" : "complete";
          if (failure) {
            item.error = runtime.summarizeError(failure.error);
            item.errorDetails = describeIllustrationError(
              failure.error,
              failure.stage,
            );
          } else {
            delete item.error;
            delete item.errorDetails;
          }
        });
      } catch (error) {
        await runtime
          .update(target, version, ({ item }) => {
            item.status = "failed";
            item.error = runtime.summarizeError(error);
            item.errorDetails = describeIllustrationError(error, stage);
          })
          .catch(() => {});
      } finally {
        if (storedId) await runtime.removeImage(storedId).catch(() => {});
      }
    });
  return {
    run,
    /**
     * Checks a specific version, or any pending version when omitted.
     *
     * 한국어: 지정한 버전 또는 버전을 생략한 경우 대상의 모든 대기 버전을 조회하는 함수.
     */
    has: (target: IllustrationTarget, version?: number) =>
      version === undefined
        ? queue.hasPrefix(`${illustrationJobKey(target)}:`)
        : queue.has(`${illustrationJobKey(target)}:${version}`),
  };
}

/**
 * Validates a loaded record before either adapter changes state or applies a result.
 *
 * 한국어: 앱·Node 어댑터가 상태를 바꾸거나 결과를 반영하기 전에 읽은 정보를 검증하는 함수.
 */
export function canUpdateIllustration(
  record: IllustrationRecord,
  version: number,
): boolean {
  return validIllustration(
    record.message,
    record.item,
    record.branchId,
    version,
  );
}
