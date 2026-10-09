"use strict";

import * as crypto from "node:crypto";
import { createChatGenerationPlan } from "../../../packages/chat-core/generation.ts";
import {
  decideAutoContinuation,
  endsWithCompletionPunctuation,
} from "../../../packages/chat-core/finalization.ts";
import { countChatTokensDetailed } from "../../../packages/chat-core/tokenAccounting.ts";
import {
  normalizeChatPlanRequest,
  normalizeChatContinuationRequest,
} from "../../../packages/protocol/chatExecutor.ts";
import { countTokensBatch as defaultCountTokensBatch } from "../util/tokenizeCount.ts";

function createNodeChatExecutor({
  countTokensBatch = defaultCountTokensBatch,
  createGenerationId = () => crypto.randomUUID(),
}: any = {}): any {
  async function planGeneration(rawInput?: any): Promise<any> {
    const normalized: any = normalizeChatPlanRequest(rawInput);
    if (normalized.error) {
      const error: any = new TypeError(normalized.error);
      error.code = "invalid_chat_plan";
      throw error;
    }
    const input: any = normalized.value;
    const runtime: any = {
      tokenizeChatsDetailed: (chats?: any) =>
        countChatTokensDetailed(
          chats,
          async (texts?: any) => countTokensBatch(texts, input.encoding),
          {
            chatAdditionalTokens: input.chatAdditionalTokens,
            useName: input.useName,
            countThoughts: input.countThoughts,
            supportsInlayImage: input.supportsInlayImage,
            visionQuality: input.visionQuality,
          },
        ),
      getGenerationSettings: () => ({
        maxResponseTokens: input.maxResponseTokens,
      }),
      createGenerationId,
      getGenerationModel: () => input.model,
      requestModel: async () => {
        throw new Error(
          "Node chat planning runtime cannot execute model requests yet",
        );
      },
    };
    const plan: any = await createChatGenerationPlan(runtime, {
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

  async function planContinuation(rawInput?: any): Promise<any> {
    const normalized: any = normalizeChatContinuationRequest(rawInput);
    if (normalized.error) {
      const error: any = new TypeError(normalized.error);
      error.code = "invalid_chat_continuation";
      throw error;
    }
    const input: any = normalized.value;
    const [generatedTokens] = await countTokensBatch(
      [input.result],
      input.encoding,
    );
    const resultTokens: any = generatedTokens + input.usedContinueTokens;
    return decideAutoContinuation({
      resultTokens,
      minimumTokens: input.minimumTokens,
      continueIncomplete: input.continueIncomplete,
      endsWithPunctuation: endsWithCompletionPunctuation(input.result),
    });
  }

  function registerRoutes(app?: any, { auth, limiter }: any = {}): any {
    const guards: any = limiter ? [limiter] : [];
    app.post(
      "/api/chat-executor/plan",
      ...guards,
      async (req?: any, res?: any, next?: any) => {
        if (auth && !(await auth(req, res))) return;
        try {
          res.send({ plan: await planGeneration(req.body) });
        } catch (error: any) {
          if (
            error?.code === "invalid_chat_plan" ||
            error instanceof RangeError
          ) {
            res.status(400).send({ error: error.message });
            return;
          }
          next(error);
        }
      },
    );

    app.post(
      "/api/chat-executor/continuation",
      ...guards,
      async (req?: any, res?: any, next?: any) => {
        if (auth && !(await auth(req, res))) return;
        try {
          res.send({ decision: await planContinuation(req.body) });
        } catch (error: any) {
          if (
            error?.code === "invalid_chat_continuation" ||
            error instanceof RangeError
          ) {
            res.status(400).send({ error: error.message });
            return;
          }
          next(error);
        }
      },
    );
  }

  return { planGeneration, planContinuation, registerRoutes };
}

export { createNodeChatExecutor };
