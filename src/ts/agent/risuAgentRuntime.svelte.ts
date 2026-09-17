import type { Chat } from "../storage/database/schema";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { isChatGenerationActive } from "../process/chatRuntimeState";
import { canMutateRisuAgentSession } from "./risuAgentModel";
import {
  createRisuAgentSession,
  ensureRisuAgentCharacter,
  getRisuAgentCharacter,
  registerRisuAgentSessionScope,
  resolveRisuAgentSession,
  selectRisuAgentSession,
} from "./risuAgentStore";

/**
 * Shared Risu Agent session runtime.
 *
 * The desktop sidebar and the (mobile) conversation canvas can be mounted at
 * the same time, so the active session and the in-flight generation flag live
 * here instead of in either component. Every mutating operation is queued, so
 * concurrent mounts cannot create two sessions or race a switch.
 */

/** Sessions sorted newest first for the sidebar and the mobile history sheet. */
export function sortRisuAgentChats(chats: readonly Chat[] | undefined): Chat[] {
  const sorted = [...(chats ?? [])];
  sorted.sort((a, b) => (b.lastDate ?? 0) - (a.lastDate ?? 0));
  return sorted;
}

export class RisuAgentRuntime {
  /** Stable id of the session shown by every mounted Risu Agent surface. */
  activeChatId = $state<string | null>(null);
  /** True until the first successful initialization. */
  loading = $state(true);
  /** True from send start to send settle; shared so the sidebar can lock. */
  sending = $state(false);
  /** Init or generation error surfaced by the conversation canvas. */
  errorText = $state<string | null>(null);

  private initializing = false;
  private initPromise: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  /** Serialize mutating work so concurrent callers cannot interleave. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** True while the session cannot be switched (generation in flight). */
  isBusy(): boolean {
    if (this.sending) return true;
    const generating = isChatGenerationActive(this.activeChatId ?? undefined);
    return !canMutateRisuAgentSession(generating);
  }

  private isInitialized(): boolean {
    if (!this.activeChatId) return false;
    const character = getRisuAgentCharacter();
    if (!character) return false;
    return (character.chats ?? []).some(
      (chat) => chat.id === this.activeChatId,
    );
  }

  /**
   * Restore or create the active session exactly once, even when the canvas
   * and the sidebar mount together. Re-runs if a previous attempt left no
   * usable session so a transient storage failure can recover on remount.
   */
  ensureInitialized(): Promise<void> {
    if (this.initializing) return this.initPromise ?? Promise.resolve();
    if (this.initPromise && this.isInitialized()) return this.initPromise;

    const run = this.enqueue(() => this.initialize());
    this.initPromise = run;
    this.initializing = true;
    void run
      .catch(() => undefined)
      .then(() => {
        this.initializing = false;
      });
    return run;
  }

  private async initialize(): Promise<void> {
    this.loading = true;
    this.errorText = null;
    try {
      const { character } = await ensureRisuAgentCharacter();
      const existing = resolveRisuAgentSession(character, this.activeChatId);
      let chatId = existing?.id ?? null;
      if (!chatId) {
        const created = await createRisuAgentSession(character);
        chatId = created.id ?? null;
      }
      this.activeChatId = chatId;
      if (chatId) {
        await this.activate(chatId);
      }
    } catch (error) {
      this.errorText = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
    }
  }

  /**
   * Switch the shared active session: persist the selection, pull the recent
   * message page, then sync this session's tool scope (and only this one).
   */
  async switchTo(chatId: string): Promise<void> {
    if (!chatId || this.isBusy() || chatId === this.activeChatId) return;
    await this.enqueue(async () => {
      if (this.isBusy() || chatId === this.activeChatId) return;
      this.activeChatId = chatId;
      await this.activate(chatId);
    });
  }

  /** Create a fresh session and make it active. */
  async createNewConversation(): Promise<void> {
    if (this.isBusy()) return;
    await this.enqueue(async () => {
      if (this.isBusy()) return;
      const character = getRisuAgentCharacter();
      if (!character) return;
      const created = await createRisuAgentSession(character);
      const createdId = created.id ?? null;
      if (!createdId) return;
      this.activeChatId = createdId;
      await this.activate(createdId);
    });
  }

  /**
   * Persist one session as the active selection, pull its recent message page,
   * then sync only that session's tool scope. Re-resolving the character after
   * the awaits keeps a store reload from leaving a stale reference behind.
   */
  private async activate(chatId: string): Promise<void> {
    const character = getRisuAgentCharacter();
    if (character) selectRisuAgentSession(character, chatId);
    await characterStore.ensureChatMessages(chatId);
    const fresh = getRisuAgentCharacter();
    const chat = (fresh?.chats ?? []).find((item) => item.id === chatId);
    if (chat) registerRisuAgentSessionScope(chat);
  }
}

export const risuAgentRuntime = new RisuAgentRuntime();
