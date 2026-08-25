'use strict';

const crypto = require('node:crypto');
const { createChatGenerationPlan } = require('../../packages/chat-core/generation.cjs');
const { countChatTokensDetailed } = require('../../packages/chat-core/tokenAccounting.cjs');
const { normalizeChatPlanRequest } = require('../../packages/protocol/chatExecutor.cjs');
const { countTokensBatch: defaultCountTokensBatch } = require('./tokenizeCount.cjs');

function createNodeChatExecutor({
  countTokensBatch = defaultCountTokensBatch,
  createGenerationId = () => crypto.randomUUID(),
} = {}) {
  async function planGeneration(rawInput) {
    const normalized = normalizeChatPlanRequest(rawInput);
    if (normalized.error) {
      const error = new TypeError(normalized.error);
      error.code = 'invalid_chat_plan';
      throw error;
    }
    const input = normalized.value;
    const runtime = {
      tokenizeChatsDetailed: (chats) => countChatTokensDetailed(
        chats,
        async (texts) => countTokensBatch(texts, input.encoding),
        {
          chatAdditionalTokens: input.chatAdditionalTokens,
          useName: input.useName,
          countThoughts: input.countThoughts,
          supportsInlayImage: input.supportsInlayImage,
          visionQuality: input.visionQuality,
        },
      ),
      getGenerationSettings: () => ({ maxResponseTokens: input.maxResponseTokens }),
      createGenerationId,
      getGenerationModel: () => input.model,
      requestModel: async () => {
        throw new Error('Node chat planning runtime cannot execute model requests yet');
      },
    };
    const plan = await createChatGenerationPlan(runtime, {
      formated: input.formated,
      maxContextTokens: input.maxContextTokens,
    });
    if (!plan.ok) return plan;
    return {
      ok: true,
      keptIndexes: plan.keptIndexes,
      inputTokens: plan.inputTokens,
      outputTokens: plan.outputTokens,
      generationId: plan.generationId,
      generationModel: plan.generationModel,
    };
  }

  function registerRoutes(app, { auth, limiter } = {}) {
    const guards = limiter ? [limiter] : [];
    app.post('/api/chat-executor/plan', ...guards, async (req, res, next) => {
      if (auth && !await auth(req, res)) return;
      try {
        res.send({ plan: await planGeneration(req.body) });
      } catch (error) {
        if (error?.code === 'invalid_chat_plan' || error instanceof RangeError) {
          res.status(400).send({ error: error.message });
          return;
        }
        next(error);
      }
    });
  }

  return { planGeneration, registerRoutes };
}

module.exports = { createNodeChatExecutor };
