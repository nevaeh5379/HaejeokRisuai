import { v4 } from "uuid";
import type { character } from "../storage/database/schema";
import type { ChatModelResponse } from "@risuai/chat-core/types.cjs";
import type { ChatTokenizer } from "../tokenizer";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import {
  registerDurableGenerationContext,
  unregisterDurableGenerationContext,
} from "../network/durableModelJobs";
import { getGenerationModelString } from "./models/modelString";
import { requestChatData } from "./request/chatRequestOrchestrator";
import type { ChatGenerationRuntime } from "@risuai/chat-core/generation.cjs";

export function createLocalChatGenerationRuntime(
  tokenizer: ChatTokenizer,
): ChatGenerationRuntime<character, ChatModelResponse> {
  return {
    tokenizeChatsDetailed: (chats) => tokenizer.tokenizeChatsDetailed(chats),
    getGenerationSettings: () => ({
      maxResponseTokens: settingsStore.state.maxResponse,
      imageResponse: settingsStore.state.outputImageModal,
      rememberToolUsage: settingsStore.state.rememberToolUsage,
    }),
    createGenerationId: v4,
    getGenerationModel: getGenerationModelString,
    requestModel: (request, signal) => requestChatData(request, "model", signal),
    registerGenerationContext: registerDurableGenerationContext,
    unregisterGenerationContext: unregisterDurableGenerationContext,
  };
}
