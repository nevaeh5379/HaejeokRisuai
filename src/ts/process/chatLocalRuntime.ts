import { v4 } from "uuid";
import type { character } from "../storage/database.svelte";
import type { ChatTokenizer } from "../tokenizer";
import {
  registerDurableGenerationContext,
  unregisterDurableGenerationContext,
} from "../network/durableModelJobs";
import { getGenerationModelString } from "./models/modelString";
import {
  requestChatData,
  type requestDataResponse,
} from "./request/request";
import type { ChatGenerationRuntime } from "./chat-core/generation";

export function createLocalChatGenerationRuntime(
  tokenizer: ChatTokenizer,
): ChatGenerationRuntime<character, requestDataResponse> {
  return {
    tokenizeChatsDetailed: (chats) => tokenizer.tokenizeChatsDetailed(chats),
    createGenerationId: v4,
    getGenerationModel: getGenerationModelString,
    requestModel: (request, signal) => requestChatData(request, "model", signal),
    registerGenerationContext: registerDurableGenerationContext,
    unregisterGenerationContext: unregisterDurableGenerationContext,
  };
}
