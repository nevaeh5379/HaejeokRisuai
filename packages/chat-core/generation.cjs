'use strict';

function hasRenderableContent(chat) {
  return chat.content !== '' || Boolean(chat.multimodals?.length);
}

async function createChatGenerationPlan(runtime, input) {
  const formated = input.formated.map((chat) => ({ ...chat }));
  const tokenCounts = await runtime.tokenizeChatsDetailed(formated);
  let inputTokens = tokenCounts.reduce((total, count) => total + count, 0);

  if (inputTokens > input.maxContextTokens) {
    let pointer = 0;
    while (inputTokens > input.maxContextTokens && pointer < formated.length) {
      if (formated[pointer].removable) {
        inputTokens -= tokenCounts[pointer];
        formated[pointer].content = '';
      }
      pointer++;
    }
    if (inputTokens > input.maxContextTokens) {
      return { ok: false, requiredTokens: inputTokens };
    }
  }

  const compacted = formated.filter(hasRenderableContent);
  const settings = runtime.getGenerationSettings();
  const outputTokens = Math.min(
    settings.maxResponseTokens,
    Math.max(0, input.maxContextTokens - inputTokens),
  );

  return {
    ok: true,
    formated: compacted,
    inputTokens,
    outputTokens,
    generationId: runtime.createGenerationId(),
    generationModel: runtime.getGenerationModel(),
  };
}

async function executeChatModelRequest(runtime, input, signal) {
  const { plan } = input;
  const settings = runtime.getGenerationSettings();
  if (input.durableChatId) {
    runtime.registerGenerationContext?.({
      realChatId: input.durableChatId,
      generationId: plan.generationId,
      model: plan.generationModel,
      speakerId: input.speakerId,
    });
  }

  try {
    return await runtime.requestModel(
      {
        formated: plan.formated,
        biasString: input.biases,
        currentChar: input.currentChar,
        useStreaming: true,
        isGroupChat: input.isGroupChat,
        bias: {},
        continue: input.continueGeneration,
        chatId: plan.generationId,
        imageResponse: settings.imageResponse,
        previewBody: input.previewBody,
        escape: input.escape,
        rememberToolUsage: settings.rememberToolUsage,
      },
      signal,
    );
  } finally {
    runtime.unregisterGenerationContext?.(plan.generationId);
  }
}

module.exports = {
  createChatGenerationPlan,
  executeChatModelRequest,
};
