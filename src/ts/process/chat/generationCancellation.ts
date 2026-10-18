import { getLogger } from "@logtape/logtape";

const logger = getLogger(["risuai", "chat", "generation"]);

/**
 * Holds the abort handle and a live lookup for a chat generation's lifecycle ID.
 * 채팅 생성의 중단 핸들과 현재 생명주기 ID 조회 함수를 보관합니다.
 */
export type LocalGeneration = {
  controller: AbortController;
  lifecycleId: () => string | undefined;
};

/**
 * Tracks local generations so a cancellation from another device can abort the right request.
 * 다른 기기의 취소 신호가 올바른 로컬 요청을 중단하도록 생성 작업을 추적합니다.
 */
export class LocalGenerationController {
  private readonly localGenerations = new Map<string, LocalGeneration>();

  /**
   * Registers the current generation for a chat, replacing an older entry if present.
   * 채팅의 현재 생성 작업을 등록하며 기존 항목이 있으면 교체합니다.
   *
   * @param chatId - Chat to associate with the generation. / 생성 작업에 연결할 채팅 ID.
   * @param generation - Abort handle and live lifecycle lookup. / 중단 핸들과 현재 생명주기 조회 함수.
   */
  register(chatId: string, generation: LocalGeneration): void {
    this.localGenerations.set(chatId, generation);
  }

  /**
   * Removes a generation only when its controller is still registered for this chat.
   * 같은 채팅의 새 작업을 오래된 작업의 정리가 지우지 않도록 controller가 일치할 때만 제거합니다.
   *
   * @param chatId - Chat whose generation is ending. / 생성 작업이 끝나는 채팅 ID.
   * @param controller - Controller owned by the ending generation. / 종료되는 생성 작업의 controller.
   */
  unregister(chatId: string, controller: AbortController): void {
    const generation = this.findRegisteredGeneration(chatId);
    if (generation && this.hasMatchingController(generation, controller)) {
      this.localGenerations.delete(chatId);
    }
  }

  /**
   * Aborts the local request only if the requested lifecycle is still active for the chat.
   * 요청한 생명주기가 해당 채팅에서 여전히 활성 상태일 때만 로컬 요청을 중단합니다.
   *
   * @param chatId - Chat receiving the remote cancellation. / 원격 취소 대상 채팅 ID.
   * @param lifecycleId - Lifecycle ID supplied by the remote event. / 원격 이벤트의 생명주기 ID.
   * @returns Whether the matching local request was aborted. / 일치하는 로컬 요청을 중단했는지 여부.
   */
  cancel(chatId: string, lifecycleId: string): boolean {
    const generation = this.findCancelableGeneration(chatId, lifecycleId);
    if (!generation) return false;
    generation.controller.abort();
    return true;
  }

  /**
   * Resolves a registered generation and verifies its lifecycle before cancellation.
   * 등록된 생성 작업을 찾고 취소 전에 생명주기 ID가 일치하는지 확인합니다.
   *
   * @param chatId - Chat to look up. / 조회할 채팅 ID.
   * @param lifecycleId - Lifecycle requested for cancellation. / 취소 요청의 생명주기 ID.
   * @returns The matching generation, or undefined when cancellation must be ignored. / 취소할 작업이며, 무시해야 하면 undefined.
   */
  private findCancelableGeneration(
    chatId: string,
    lifecycleId: string,
  ): LocalGeneration | undefined {
    const generation = this.findRegisteredGeneration(chatId, lifecycleId);
    if (
      !generation ||
      !this.hasMatchingLifecycle(generation, chatId, lifecycleId)
    ) {
      return undefined;
    }
    return generation;
  }

  /**
   * Looks up a chat generation; logs a missing entry only for a cancellation request.
   * 채팅 생성 작업을 조회하고, 취소 요청에서 항목이 없을 때만 경고를 남깁니다.
   *
   * @param chatId - Chat to look up. / 조회할 채팅 ID.
   * @param lifecycleId - Present for cancellation, omitted for routine cleanup. / 취소 요청에는 전달하고 일반 정리에는 생략합니다.
   * @returns The registered generation, if any. / 등록된 생성 작업 또는 undefined.
   */
  private findRegisteredGeneration(
    chatId: string,
    lifecycleId?: string,
  ): LocalGeneration | undefined {
    const generation = this.localGenerations.get(chatId);
    if (!generation && lifecycleId !== undefined) {
      logger.warn("generation-cancel.failed {reason}", {
        reason: "no-active",
        chatId,
        lifecycleId,
      });
    }
    return generation;
  }

  /**
   * Checks controller identity so an old generation cannot unregister its replacement.
   * 오래된 생성 작업이 새 작업의 등록을 해제하지 못하도록 controller 동일성을 확인합니다.
   *
   * @param generation - Currently registered generation. / 현재 등록된 생성 작업.
   * @param controller - Controller requesting cleanup. / 정리를 요청한 controller.
   * @returns Whether the registered controller belongs to the ending generation. / 등록된 controller가 종료 작업의 것인지 여부.
   */
  private hasMatchingController(
    generation: LocalGeneration,
    controller: AbortController,
  ): boolean {
    return generation.controller === controller;
  }

  /**
   * Compares the current lifecycle ID with the remote cancellation and logs a mismatch.
   * 현재 생명주기 ID와 원격 취소 ID를 비교하고 불일치 시 경고를 남깁니다.
   *
   * @param generation - Currently registered generation. / 현재 등록된 생성 작업.
   * @param chatId - Chat receiving the cancellation. / 취소 대상 채팅 ID.
   * @param lifecycleId - Lifecycle requested for cancellation. / 취소 요청의 생명주기 ID.
   * @returns Whether the cancellation targets this generation. / 취소가 이 생성 작업을 대상으로 하는지 여부.
   */
  private hasMatchingLifecycle(
    generation: LocalGeneration,
    chatId: string,
    lifecycleId: string,
  ): boolean {
    const activeLifecycleId = generation.lifecycleId();
    if (activeLifecycleId !== lifecycleId) {
      logger.warn("generation-cancel.failed {reason}", {
        reason: "lifecycle-mismatch",
        chatId,
        lifecycleId,
        activeLifecycleId,
      });
      return false;
    }
    return true;
  }
}

/** Shared registry used by chat execution and realtime event handling. / 채팅 실행과 실시간 이벤트 처리가 공유하는 등록기입니다. */
export const localGenerationController = new LocalGenerationController();
