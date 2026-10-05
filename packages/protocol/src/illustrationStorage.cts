import type {
  IllustrationMessage,
  IllustrationTarget,
} from "./illustration.cjs";

export interface IllustrationStorageReader {
  loadChat(
    chatId: string,
    options?: { messageLimit?: number },
  ): Promise<{
    activeBranchId?: string;
    message?: IllustrationMessage[];
  } | null>;
  loadChatMessagePage(
    chatId: string,
    before: number | undefined,
    limit: number,
  ): Promise<{
    messages: IllustrationMessage[];
    offset: number;
    hasMore: boolean;
  }>;
}

/** Page through SQL without hydrating a whole history into RAM. */
export async function readIllustrationMessage(
  storage: IllustrationStorageReader,
  target: Pick<IllustrationTarget, "chatId" | "messageId">,
) {
  const chat = await storage.loadChat(target.chatId, { messageLimit: 1 });
  if (!chat) return null;
  let before: number | undefined;
  while (true) {
    const page = await storage.loadChatMessagePage(target.chatId, before, 50);
    const index = page.messages.findIndex((m) => m.chatId === target.messageId);
    if (index >= 0)
      return {
        message: page.messages[index],
        branchId: chat.activeBranchId,
        position: page.offset + index,
      };
    if (!page.hasMore || page.offset <= 0) return null;
    before = page.offset;
  }
}

/** Fetch only the requested recent messages ending before the target answer. */
export async function readIllustrationHistory(
  storage: IllustrationStorageReader,
  chatId: string,
  position: number,
  count: number,
): Promise<IllustrationMessage[]> {
  if (!position || !count) return [];
  const messages: IllustrationMessage[] = [];
  let before = position;
  while (messages.length < count && before > 0) {
    const page = await storage.loadChatMessagePage(
      chatId,
      before,
      Math.min(50, count - messages.length),
    );
    messages.unshift(...page.messages);
    if (!page.hasMore || page.offset >= before) break;
    before = page.offset;
  }
  return messages.slice(-count);
}
