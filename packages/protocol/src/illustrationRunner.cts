import {
  cleanIllustrationTags,
  IllustrationQueue,
  validIllustration,
  type Illustration,
  type IllustrationMessage,
  type IllustrationTarget,
} from "./illustration.cjs";

export interface IllustrationRecord {
  message: IllustrationMessage;
  item: Illustration;
  branchId?: string;
}

export interface IllustrationRuntime {
  /** Read/check/write against the latest version; null means the job was invalidated. */
  update(
    target: IllustrationTarget,
    version: number,
    change: (record: IllustrationRecord) => void,
  ): Promise<IllustrationRecord | null>;
  createTags(
    target: IllustrationTarget,
    record: IllustrationRecord,
  ): Promise<string>;
  prompts(
    tags: string,
    target: IllustrationTarget,
  ): Promise<{ prompt: string; negativePrompt: string }>;
  createImage(
    prompt: string,
    negativePrompt: string,
    target: IllustrationTarget,
  ): Promise<string>;
  storeImage(data: string): Promise<string>;
  removeImage(id: string): Promise<void>;
  summarizeError(error: unknown): string;
}

export function illustrationJobKey(target: IllustrationTarget): string {
  return JSON.stringify([
    target.characterId,
    target.chatId,
    target.messageId,
    target.illustrationId,
  ]);
}

export function createIllustrationRunner(runtime: IllustrationRuntime) {
  const queue = new IllustrationQueue();
  const run = (target: IllustrationTarget, version: number) =>
    queue.enqueue(`${illustrationJobKey(target)}:${version}`, async () => {
      let storedId: string | undefined;
      try {
        let record = await runtime.update(target, version, () => {});
        if (!record) return;
        if (!record.item.tags) {
          record = await runtime.update(target, version, ({ item }) => {
            item.status = "tagging";
          });
          if (!record) return;
          const tags = cleanIllustrationTags(
            await runtime.createTags(target, record),
          );
          const prompts = await runtime.prompts(tags, target);
          record = await runtime.update(target, version, ({ item }) => {
            Object.assign(item, prompts, { tags });
          });
          if (!record) return;
        }
        if (!record.item.prompt) {
          const prompts = await runtime.prompts(record.item.tags!, target);
          record = await runtime.update(target, version, ({ item }) => {
            Object.assign(item, prompts);
          });
          if (!record) return;
        }
        record = await runtime.update(target, version, ({ item }) => {
          item.status = "generating";
          delete item.error;
        });
        if (!record) return;
        const data = await runtime.createImage(
          record.item.prompt!,
          record.item.negativePrompt ?? "",
          target,
        );
        if (!(await runtime.update(target, version, () => {}))) return;
        storedId = await runtime.storeImage(data);
        const completed = await runtime.update(
          target,
          version,
          ({ message, item }) => {
            const token = `{{inlay::${storedId}}}`;
            message.data = message.data.replace(item.token, token);
            Object.assign(item, {
              token,
              imageId: storedId,
              status: "complete",
            });
            delete item.error;
          },
        );
        if (completed) storedId = undefined;
      } catch (error) {
        await runtime
          .update(target, version, ({ item }) => {
            item.status = "failed";
            item.error = runtime.summarizeError(error);
          })
          .catch(() => {});
      } finally {
        if (storedId) await runtime.removeImage(storedId).catch(() => {});
      }
    });
  return {
    run,
    has: (target: IllustrationTarget, version?: number) =>
      version === undefined
        ? queue.hasPrefix(`${illustrationJobKey(target)}:`)
        : queue.has(`${illustrationJobKey(target)}:${version}`),
  };
}

/** Used by both adapters before every state transition and result application. */
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
