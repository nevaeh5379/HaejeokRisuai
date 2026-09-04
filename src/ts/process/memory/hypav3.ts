import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { type memoryVector, HypaProcesser, similarity } from "./hypamemory";
import { isContextModel, getContextProvider } from "./contextualEmbedding";
import { TaskRateLimiter } from "./taskRateLimiter";
import {
  type EmbeddingText,
  type EmbeddingResult,
  HypaProcessorV2,
} from "./hypamemoryv2";
import { parseChatML } from "src/ts/parser/chatML";
import type { Chat, character, groupChat } from "../../storage/database/schema";

import { type OpenAIChat } from "@risuai/chat-core/types.cjs";
import { requestChatData } from "../request/chatRequestOrchestrator";
import { hypaV3ProgressStore } from "src/ts/stores.svelte";
import { type ChatTokenizer } from "src/ts/tokenizer";
import { inlayTokenRegex } from "src/ts/util/inlayTokens";
import { type HypaV3Preset, type HypaV3Settings } from "./hypav3Preset";
import {
  tryRunNodeHypaMemory,
  type HypaGenerationContext,
} from "./nodeHypaMemory";
import {
  runHypaV3Experimental,
  type HypaV3EmbeddingProcessor,
  type HypaV3RateLimiter,
  type HypaV3Runtime,
} from "@risuai/hypa-v3/engine";
import { runHypaV3Legacy } from "@risuai/hypa-v3/legacyEngine";
import type {
  HypaV3Summary as Summary,
  SerializableHypaV3Data,
  SerializableHypaV3Summary as SerializableSummary,
} from "@risuai/hypa-v3/types";

export { createHypaV3Preset } from "./hypav3Preset";
export type { HypaV3Preset, HypaV3Settings } from "./hypav3Preset";

export type {
  SerializableHypaV3Data,
  SerializableHypaV3Summary as SerializableSummary,
} from "@risuai/hypa-v3/types";

interface SummaryChunk {
  text: string;
  summary: Summary;
}

export interface HypaV3Result {
  currentTokens: number;
  chats: OpenAIChat[];
  error?: string;
  memory?: SerializableHypaV3Data;
}

const logPrefix = "[HypaV3]";

export async function hypaMemoryV3(
  chats: OpenAIChat[],
  currentTokens: number,
  maxContextTokens: number,
  room: Chat,
  char: character | groupChat,
  tokenizer: ChatTokenizer,
  context: HypaGenerationContext = {},
): Promise<HypaV3Result> {
  const settings = getCurrentHypaV3Preset().settings;

  try {
    const db = settingsStore.state;
    const nodeResult = await tryRunNodeHypaMemory<HypaV3Result>(
      {
        mode: "v3",
        chats,
        currentTokens,
        maxContextTokens,
        room: { id: room.id, hypaV3Data: room.hypaV3Data },
        character: { id: char.chaId, name: char.name, type: char.type },
        config: {
          maxResponse: presetStore.state.maxResponse,
          hypaModel: db.hypaModel,
          supaMemoryKey: db.supaMemoryKey,
          customEmbedding: {
            url: db.hypaCustomSettings?.url ?? "",
            key: db.hypaCustomSettings?.key ?? "",
            model: db.hypaCustomSettings?.model ?? "",
          },
          voyageApiKey: db.voyageApiKey ?? "",
          v3Settings: settings,
        },
      },
      tokenizer,
      context,
    );
    if (nodeResult.handled) return nodeResult.result;

    if (settings.useExperimentalImpl) {
      console.log(logPrefix, "Using experimental implementation.");

      return await hypaMemoryV3MainExp(
        chats,
        currentTokens,
        maxContextTokens,
        room,
        char,
        tokenizer,
        context,
      );
    }

    return await hypaMemoryV3Main(
      chats,
      currentTokens,
      maxContextTokens,
      room,
      char,
      tokenizer,
      context,
    );
  } catch (error) {
    if (error instanceof Error) {
      // Standard Error instance
      error.message = `${logPrefix} ${error.message}`;
      throw error;
    }

    // Fallback for non-Error object
    let errorMessage: string;

    try {
      errorMessage = JSON.stringify(error);
    } catch {
      errorMessage = String(error);
    }

    throw new Error(`${logPrefix} ${errorMessage}`);
  }
}

async function hypaMemoryV3MainExp(
  chats: OpenAIChat[],
  currentTokens: number,
  maxContextTokens: number,
  room: Chat,
  char: character | groupChat,
  tokenizer: ChatTokenizer,
  context: HypaGenerationContext,
): Promise<HypaV3Result> {
  const settings = getCurrentHypaV3Preset().settings;

  return (await runHypaV3Experimental(
    {
      chats,
      currentTokens,
      maxContextTokens,
      maxResponseTokens: presetStore.state.maxResponse,
      memory: room.hypaV3Data,
      conversationId: room.id,
      characterId: char.chaId,
      settings,
      tokenizer: {
        tokenizeChat: (chat) => tokenizer.tokenizeChat(chat as OpenAIChat),
        tokenizeChatsDetailed: (messages) =>
          tokenizer.tokenizeChatsDetailed(messages as OpenAIChat[]),
      },
    },
    createHypaV3Runtime(context),
  )) as HypaV3Result;
}
async function hypaMemoryV3Main(
  chats: OpenAIChat[],
  currentTokens: number,
  maxContextTokens: number,
  room: Chat,
  char: character | groupChat,
  tokenizer: ChatTokenizer,
  context: HypaGenerationContext,
): Promise<HypaV3Result> {
  const settings = getCurrentHypaV3Preset().settings;

  return (await runHypaV3Legacy(
    {
      chats,
      currentTokens,
      maxContextTokens,
      maxResponseTokens: presetStore.state.maxResponse,
      memory: room.hypaV3Data,
      conversationId: room.id,
      characterId: char.chaId,
      settings,
      tokenizer: {
        tokenizeChat: (chat) => tokenizer.tokenizeChat(chat as OpenAIChat),
        tokenizeChatsDetailed: (messages) =>
          tokenizer.tokenizeChatsDetailed(messages as OpenAIChat[]),
      },
    },
    createHypaV3Runtime(context),
  )) as HypaV3Result;
}

function createHypaV3Runtime(context: HypaGenerationContext): HypaV3Runtime {
  return {
    createRateLimiter: (options) =>
      new TaskRateLimiter(options) as HypaV3RateLimiter,
    createEmbeddingProcessor: <Metadata>(options: {
      serverIndexId: string;
      rateLimiter: HypaV3RateLimiter;
    }) =>
      new HypaProcessorV2<Metadata>({
        serverIndexId: options.serverIndexId,
        rateLimiter: options.rateLimiter as TaskRateLimiter,
      }) as unknown as HypaV3EmbeddingProcessor<Metadata>,
    createLegacyEmbeddingProcessor: ({ serverIndexId }) => {
      const db = settingsStore.state;
      const processor = new HypaProcesserEx(
        db.hypaModel,
        undefined,
        serverIndexId,
      );
      processor.oaikey = db.supaMemoryKey;
      return processor;
    },
    summarize: (messages, isResummarize) =>
      summarize(messages as OpenAIChat[], isResummarize, context),
    onProgress: (progress) => hypaV3ProgressStore.set(progress),
    random: Math.random,
  };
}

function sanitizeSummaryContent(content: string): string {
  return content.replace(inlayTokenRegex, "[Image]");
}

export async function summarize(
  oaiMessages: OpenAIChat[],
  isResummarize: boolean = false,
  context: HypaGenerationContext = {},
): Promise<string> {
  const db = settingsStore.state;
  const settings = getCurrentHypaV3Preset().settings;

  const strMessages = oaiMessages
    .map((chat) => `${chat.role}: ${sanitizeSummaryContent(chat.content)}`)
    .join("\n");

  const summarizationPrompt = isResummarize
    ? settings.reSummarizationPrompt.trim() === ""
      ? "Re-summarize this summaries."
      : settings.reSummarizationPrompt
    : settings.summarizationPrompt.trim() === ""
      ? "[Summarize the ongoing role story, It must also remove redundancy and unnecessary text and content from the output.]"
      : settings.summarizationPrompt;

  const formated: OpenAIChat[] = parseChatML(
    summarizationPrompt.replaceAll("{{slot}}", strMessages),
  ) ?? [
    {
      role: "user",
      content: strMessages,
    },
    {
      role: "system",
      content: summarizationPrompt,
    },
  ];

  console.log(
    logPrefix,
    `Using ax model ${presetStore.state.subModel} for summarization.`,
  );

  const response = await requestChatData(
    {
      formated,
      bias: {},
      useStreaming: false,
      noMultiGen: true,
      currentChar: context.currentChar,
      triggerTarget: context.chatTarget,
    },
    "memory",
  );

  if (response.type === "streaming" || response.type === "multiline") {
    throw new Error("Unexpected response type");
  }

  if (response.type === "fail") {
    throw new Error(response.result);
  }

  if (!response.result || response.result.trim().length === 0) {
    throw new Error("Empty summary returned");
  }

  const thoughtsRegex = /<Thoughts>[\s\S]*?<\/Thoughts>/g;
  const result = response.result.replace(thoughtsRegex, "").trim();

  if (result.length === 0) {
    throw new Error("Empty summary after removing thoughts content");
  }

  return result;
}

export function getCurrentHypaV3Preset(): HypaV3Preset {
  const db = settingsStore.state;
  const preset = db.hypaV3Presets?.[db.hypaV3PresetId];

  if (!preset) {
    throw new Error("Preset not found. Please select a valid preset.");
  }

  return preset;
}

interface SummaryChunkVector {
  chunk: SummaryChunk;
  vector: memoryVector;
}

class HypaProcesserEx extends HypaProcesser {
  // Maintain references to SummaryChunks and their associated memoryVectors
  // only for browser/contextual fallback. Node text indexes keep just chunks.
  summaryChunkVectors: SummaryChunkVector[] = [];
  private serverSummaryChunks: SummaryChunk[] | null = null;

  async addSummaryChunks(chunks: SummaryChunk[]): Promise<void> {
    if (isContextModel(this.model)) {
      await this.addSummaryChunksContextual(chunks);
      return;
    }

    const texts = chunks.map((chunk) => chunk.text);
    if (await this.prepareServerTextIndex(texts)) {
      this.serverSummaryChunks = chunks.slice();
      return;
    }
    await this.addText(texts);

    const newSummaryChunkVectors: SummaryChunkVector[] = [];
    for (const chunk of chunks) {
      const vector = this.vectors.find((v) => v.content === chunk.text);
      if (!vector) {
        throw new Error(
          `Failed to create vector for summary chunk:\n${chunk.text}`,
        );
      }
      newSummaryChunkVectors.push({ chunk, vector });
    }

    this.summaryChunkVectors.push(...newSummaryChunkVectors);
  }

  private async addSummaryChunksContextual(
    chunks: SummaryChunk[],
  ): Promise<void> {
    const provider = getContextProvider(this.model);

    const cacheKeyFor = (text: string, groupTexts: string[]) => {
      return `${text}${provider.getCacheKeySuffix(groupTexts)}`;
    };

    const summaryGroups = new Map<Summary, SummaryChunk[]>();
    for (const chunk of chunks) {
      const group = summaryGroups.get(chunk.summary) || [];
      group.push(chunk);
      summaryGroups.set(chunk.summary, group);
    }

    const groupsToEmbed: SummaryChunk[][] = [];
    const cachedVectors = new Map<string, memoryVector>();

    for (const [, group] of summaryGroups) {
      const groupTexts = group.map((c) => c.text);
      let allCached = true;
      const groupCache = new Map<string, memoryVector>();

      for (const chunk of group) {
        const cached: memoryVector = await this.forage.getItem(
          cacheKeyFor(chunk.text, groupTexts),
        );
        if (cached) {
          groupCache.set(chunk.text, cached);
        } else {
          allCached = false;
        }
      }

      if (allCached) {
        for (const [text, vector] of groupCache) {
          cachedVectors.set(text, vector);
        }
      } else {
        groupsToEmbed.push(group);
      }
    }

    if (groupsToEmbed.length > 0) {
      const groups = groupsToEmbed.map((group) =>
        group.map((chunk) => chunk.text),
      );

      const results = await provider.embedDocumentGroups(groups);

      for (let i = 0; i < groupsToEmbed.length; i++) {
        const group = groupsToEmbed[i];
        const groupTexts = group.map((c) => c.text);
        const embeddings = results[i];

        for (let j = 0; j < group.length; j++) {
          const chunk = group[j];
          const embedding = embeddings[j];
          const vector: memoryVector = {
            content: chunk.text,
            embedding,
          };

          await this.forage.setItem(
            cacheKeyFor(chunk.text, groupTexts),
            vector,
          );
          cachedVectors.set(chunk.text, vector);
        }
      }
    }

    for (const chunk of chunks) {
      const vector = cachedVectors.get(chunk.text);
      if (!vector) {
        throw new Error(
          `Failed to create vector for summary chunk:\n${chunk.text}`,
        );
      }

      this.vectors.push(vector);
      this.summaryChunkVectors.push({ chunk, vector });
    }
  }

  async similaritySearchScoredEx(
    query: string,
  ): Promise<[SummaryChunk, number][]> {
    const queryVector = (await this.getEmbeds(query))[0];

    if (this.serverSummaryChunks) {
      const scoredTexts =
        await this.similaritySearchVectorWithScore(queryVector);
      const chunksByText = new Map<string, SummaryChunk[]>();
      for (const chunk of this.serverSummaryChunks) {
        const bucket = chunksByText.get(chunk.text) ?? [];
        bucket.push(chunk);
        chunksByText.set(chunk.text, bucket);
      }
      return scoredTexts.flatMap(([text, score]) => {
        const chunk = chunksByText.get(text)?.shift();
        return chunk ? [[chunk, score] as [SummaryChunk, number]] : [];
      });
    }

    return this.summaryChunkVectors
      .map((scv) => ({
        chunk: scv.chunk,
        similarity: similarity(queryVector, scv.vector.embedding),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .map((result) => [result.chunk, result.similarity]);
  }
}
