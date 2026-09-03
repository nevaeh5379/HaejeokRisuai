export interface ChatSendOptions {
  chatAdditonalTokens?: number;
  signal?: AbortSignal;
  continue?: boolean;
  usedContinueTokens?: number;
  preview?: boolean;
  previewPrompt?: boolean;
  targetCharacterId?: string;
  targetChatId?: string;
}

export interface ChatExecutor {
  execute(
    chatProcessIndex?: number,
    options?: ChatSendOptions,
  ): Promise<boolean>;
}
