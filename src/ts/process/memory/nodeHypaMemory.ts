import type { OpenAIChat } from "@risuai/chat-core/types.cjs";
import { risuChatParser } from "../../parser/parser.svelte";
import type { ChatExecutionTarget } from "src/ts/chatTarget";
import type { character } from "../../storage/schema";
import { forageStorage } from "../../globalApi.svelte";
import { isNodeServer } from "../../platform";
import { NodeStorage } from "../../storage/nodeStorage";
import { tokenize as countPlainTokens, type ChatTokenizer } from "../../tokenizer";
import { requestChatData } from "../request/chatRequestOrchestrator";
import { runSummarizer } from "../transformers";
import { chatCompletion } from "../webllm";

type HypaAction =
  | { id: string; type: "tokenize"; messages: OpenAIChat[] }
  | { id: string; type: "tokenize-texts"; texts: string[] }
  | { id: string; type: "distilbart"; text: string }
  | {
      id: string;
      type: "summarize";
      messages: OpenAIChat[];
      parseContents?: boolean;
      model: string;
      localModel?: boolean;
      maxTokens?: number;
    };

type HypaSessionResponse<T> =
  | { status: "done"; result: T }
  | { status: "action"; sessionId: string; action: HypaAction };

export type NodeHypaResult<T> =
  | { handled: false }
  | { handled: true; result: T };

export type HypaGenerationContext = {
  currentChar?: character;
  chatTarget?: ChatExecutionTarget;
};

function parseActionMessages(
  messages: OpenAIChat[],
  parseContents: boolean | undefined,
  context: HypaGenerationContext,
): OpenAIChat[] {
  if (!parseContents) return messages;
  return messages.map((message) => ({
    ...message,
    content: risuChatParser(message.content, {
      chara: context.currentChar,
      chatTarget: context.chatTarget,
    }),
  }));
}

async function executeAction(
  action: HypaAction,
  tokenizer: ChatTokenizer,
  context: HypaGenerationContext,
): Promise<unknown> {
  if (action.type === "tokenize") {
    return await tokenizer.tokenizeChatsDetailed(action.messages);
  }

  if (action.type === "tokenize-texts") {
    const counts: number[] = [];
    for (const text of action.texts) counts.push(await countPlainTokens(text));
    return counts;
  }

  if (action.type === "distilbart") {
    try {
      return { ok: true, text: await runSummarizer(action.text) };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  const messages = parseActionMessages(
    action.messages,
    action.parseContents,
    context,
  );
  if (action.localModel) {
    try {
      const firstSystemIndex = messages.findIndex(
        (message) => message.role === "system",
      );
      if (firstSystemIndex > 0) {
        const [system] = messages.splice(firstSystemIndex, 1);
        messages.unshift(system);
      }
      const text = await chatCompletion(messages, action.model, {
        max_tokens: action.maxTokens ?? 8192,
        temperature: 0,
        extra_body: { enable_thinking: false },
      });
      return text?.trim()
        ? { ok: true, text }
        : { ok: false, error: "Empty summary returned" };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  const response = await requestChatData(
    {
      formated: messages,
      bias: {},
      useStreaming: false,
      noMultiGen: true,
      currentChar: context.currentChar,
      triggerTarget: context.chatTarget,
    },
    "memory",
  );
  if (
    response.type === "fail" ||
    response.type === "streaming" ||
    response.type === "multiline"
  ) {
    return { ok: false, error: response.result };
  }
  return response.result?.trim()
    ? { ok: true, text: response.result }
    : { ok: false, error: "Empty summary returned" };
}

/**
 * Runs Hypa's state machine on the Node backend. The browser only supplies
 * platform-specific primitives that cannot be reconstructed server-side
 * (custom tokenizers and model runtimes). Once a server session has started,
 * failures are terminal so we never replay summarization locally by accident.
 */
export async function tryRunNodeHypaMemory<T>(
  request: unknown,
  tokenizer: ChatTokenizer,
  context: HypaGenerationContext = {},
): Promise<NodeHypaResult<T>> {
  if (!isNodeServer || !(forageStorage.realStorage instanceof NodeStorage)) {
    return { handled: false };
  }

  const storage = forageStorage.realStorage;
  let response: HypaSessionResponse<T>;
  try {
    response = await storage.startHypaMemorySession(request);
  } catch (error) {
    const status = Number((error as any)?.status);
    if (status === 404 || status === 405) {
      return { handled: false };
    }
    throw error;
  }

  let sessionId = response.status === "action" ? response.sessionId : "";
  try {
    while (response.status === "action") {
      sessionId = response.sessionId;
      const value = await executeAction(response.action, tokenizer, context);
      response = await storage.continueHypaMemorySession(
        response.sessionId,
        response.action.id,
        value,
      );
    }
    return { handled: true, result: response.result };
  } catch (error) {
    if (sessionId) await storage.cancelHypaMemorySession(sessionId);
    throw error;
  }
}
