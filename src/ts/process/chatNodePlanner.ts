import type {
  ChatGenerationPlan,
  ChatGenerationSettings,
} from "@risuai/chat-core/generation.cjs";
import type { AutoContinuationDecision } from "@risuai/chat-core/finalization.cjs";
import type { OpenAIChat } from "@risuai/chat-core/types.cjs";
import { forageStorage } from "../globalApi.svelte";
import { isNodeServer } from "../platform";
import { NodeStorage } from "../storage/files/nodeStorage";
import { ChatTokenizer, getServerTiktokenEncoding } from "../tokenizer";

interface GenerationPlanRuntimeView {
  getGenerationSettings(): ChatGenerationSettings;
  getGenerationModel(model?: string): string;
}

export interface NodeChatPlanOptions {
  formated: OpenAIChat[];
  maxContextTokens: number;
  tokenizer: ChatTokenizer;
  runtime: GenerationPlanRuntimeView;
}

export async function tryCreateNodeChatGenerationPlan(
  options: NodeChatPlanOptions,
): Promise<ChatGenerationPlan | null> {
  if (!isNodeServer || !(forageStorage.realStorage instanceof NodeStorage)) {
    return null;
  }

  const encoding = getServerTiktokenEncoding();
  if (!encoding) return null;

  const accounting = options.tokenizer.getTokenAccountingOptions(false);
  const settings = options.runtime.getGenerationSettings();
  try {
    const remotePlan = await forageStorage.realStorage.planChatGeneration({
      formated: options.formated.map((chat) => ({
        ...chat,
        multimodals: chat.multimodals?.map((multimodal) => ({
          ...multimodal,
          base64: "",
        })),
      })),
      maxContextTokens: options.maxContextTokens,
      maxResponseTokens: settings.maxResponseTokens,
      chatAdditionalTokens: accounting.chatAdditionalTokens,
      encoding,
      useName: accounting.useName,
      countThoughts: accounting.countThoughts,
      supportsInlayImage: accounting.supportsInlayImage,
      visionQuality: accounting.visionQuality,
      model: options.runtime.getGenerationModel(),
    });
    if (remotePlan.ok === false) {
      return { ok: false, requiredTokens: remotePlan.requiredTokens };
    }
    return {
      ...remotePlan,
      formated: remotePlan.keptIndexes.map((index) => options.formated[index]),
    };
  } catch (error) {
    console.warn(
      "Server chat planning failed; falling back to local generation planning",
      error,
    );
    return null;
  }
}

export async function tryCreateNodeAutoContinuationDecision(
  result: string,
  usedContinueTokens: number,
  minimumTokens: number,
  continueIncomplete: boolean,
): Promise<AutoContinuationDecision | null> {
  if (!isNodeServer || !(forageStorage.realStorage instanceof NodeStorage)) {
    return null;
  }
  const encoding = getServerTiktokenEncoding();
  if (!encoding) return null;
  try {
    return await forageStorage.realStorage.planChatContinuation({
      result,
      encoding,
      usedContinueTokens,
      minimumTokens,
      continueIncomplete,
    });
  } catch (error) {
    console.warn(
      "Server chat continuation planning failed; falling back to local policy",
      error,
    );
    return null;
  }
}
