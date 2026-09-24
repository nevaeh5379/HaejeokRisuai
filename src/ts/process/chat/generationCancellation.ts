import { getLogger } from "@logtape/logtape";

const logger = getLogger(["risuai", "chat", "generation"]);

export type LocalGeneration = {
  controller: AbortController;
  lifecycleId: () => string | undefined;
};

export class LocalGenerationController {
  private readonly localGenerations = new Map<string, LocalGeneration>();

  register(chatId: string, generation: LocalGeneration): void {
    this.localGenerations.set(chatId, generation);
  }

  unregister(chatId: string, controller: AbortController): void {
    const generation = this.findRegisteredGeneration(chatId);
    if (generation && this.hasMatchingController(generation, controller)) {
      this.localGenerations.delete(chatId);
    }
  }

  cancel(chatId: string, lifecycleId: string): boolean {
    const generation = this.findCancelableGeneration(chatId, lifecycleId);
    if (!generation) return false;
    generation.controller.abort();
    return true;
  }

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

  private hasMatchingController(
    generation: LocalGeneration,
    controller: AbortController,
  ): boolean {
    return generation.controller === controller;
  }

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

export const localGenerationController = new LocalGenerationController();
