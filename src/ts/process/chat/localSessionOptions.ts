import type {
  ChatExecutor,
  ChatSendOptions,
} from "@risuai/chat-core/executor.cjs";
import type { ChatErrorContext } from "./error.svelte";
import type {
  GroupGenerationRequest,
  PrepareChatSessionOptions,
} from "./session.svelte";

interface LocalSessionOptionsInit {
  chatProcessIndex: number;
  arg: ChatSendOptions;
  abortSignal: AbortSignal;
  errorContext: ChatErrorContext;
  throwError: (error: string) => void;
  execute: ChatExecutor["execute"];
}

/**
 * 로컬 채팅 실행기의 세션 준비 옵션과 그룹 구성원 재호출을 묶습니다.
 * Holds session preparation options and group member dispatch for the local chat executor.
 */
export class LocalPrepareChatSessionOptions implements PrepareChatSessionOptions {
  readonly chatProcessIndex: number;
  readonly chatAdditonalTokens?: number;
  readonly abortSignal: AbortSignal;
  readonly errorContext: ChatErrorContext;
  readonly throwError: (error: string) => void;
  readonly targetCharacterId?: string;
  readonly targetChatId?: string;

  private readonly execute: ChatExecutor["execute"];

  /**
   * 요청 옵션에서 세션 준비에 필요한 값과 실행 콜백을 보관합니다.
   * Stores the values and execution callback needed to prepare the session.
   *
   * @param init - 실행 옵션과 오류·취소 처리 정보 / Execution options and error and cancellation context.
   */
  constructor(init: LocalSessionOptionsInit) {
    this.chatProcessIndex = init.chatProcessIndex;
    this.chatAdditonalTokens = init.arg.chatAdditonalTokens;
    this.abortSignal = init.abortSignal;
    this.errorContext = init.errorContext;
    this.throwError = init.throwError;
    this.targetCharacterId = init.arg.targetCharacterId;
    this.targetChatId = init.arg.targetChatId;
    this.execute = init.execute;
  }

  /**
   * 그룹 구성원을 같은 채팅 대상과 취소 신호로 실행합니다.
   * Runs a group member with the same chat target and cancellation signal.
   *
   * @param request - 구성원 순서와 추가 토큰, 취소 신호 / Member index, extra tokens, and cancellation signal.
   * @returns 구성원의 생성 결과 / Member generation result.
   */
  sendGroupMember(request: GroupGenerationRequest): Promise<boolean> {
    return this.execute(request.chatProcessIndex, {
      chatAdditonalTokens: request.chatAdditonalTokens,
      signal: request.signal,
      targetCharacterId: this.targetCharacterId,
      targetChatId: this.targetChatId,
    });
  }
}
