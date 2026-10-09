import type {
  IllustrationMessage,
  IllustrationTarget,
} from "./illustration.ts";

/**
 * Provides bounded chat metadata and message pages without loading full conversations.
 *
 * 한국어: 전체 대화를 적재하지 않고 제한된 채팅 메타데이터·메시지 페이지를 읽는 저장소 계약.
 */
export interface IllustrationStorageReader {
  /**
   * Loads chat metadata with an optional resident message limit.
   *
   * 한국어: 선택한 메시지 수 제한으로 채팅 메타데이터를 읽는 함수.
   */
  loadChat(
    chatId: string,
    options?: { messageLimit?: number },
  ): Promise<{
    activeBranchId?: string;
    message?: IllustrationMessage[];
  } | null>;
  /**
   * Reads a page of messages ending before the given absolute position.
   *
   * 한국어: 지정한 절대 위치 이전에서 끝나는 메시지 페이지를 읽는 함수.
   */
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

/**
 * Locates a message by stable ID using SQL pages of at most 50 messages.
 *
 * 한국어: 최대 50개씩 SQL 페이지를 읽어 안정적인 ID로 대상 메시지를 찾는 함수.
 *
 * @param storage - Paged chat storage. / 페이지 조회를 지원하는 채팅 저장소.
 * @param target - Chat and message IDs. / 채팅·메시지 ID.
 * @returns The message, active branch and absolute position, or null if absent. / 메시지·활성 분기·절대 위치 또는 대상이 없을 때 null.
 * @remarks
 * Discards earlier pages rather than retaining the whole history in memory.
 * 한국어: 전체 이력을 메모리에 쌓지 않고 이전 조회 페이지를 해제하는 방식.
 */
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

/**
 * Reads only the requested number of recent messages preceding a target answer.
 *
 * 한국어: 대상 답변 이전의 최근 메시지를 요청한 개수만큼만 읽는 함수.
 *
 * @param storage - Paged chat storage. / 페이지 조회를 지원하는 채팅 저장소.
 * @param chatId - Stable chat ID. / 안정적인 채팅 ID.
 * @param position - Target answer's absolute position, excluded from history. / 이력에 포함하지 않을 대상 답변의 절대 위치.
 * @param count - Maximum number of prior messages. / 이전 메시지의 최대 개수.
 * @returns Previous messages in chronological order. / 시간순으로 정렬한 이전 메시지 목록.
 */
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
