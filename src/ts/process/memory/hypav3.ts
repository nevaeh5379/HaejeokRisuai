import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { type memoryVector, HypaProcesser, similarity } from "./hypamemory";
import { isContextModel, getContextProvider } from "./contextualEmbedding";
import { TaskRateLimiter } from "./taskRateLimiter";
import {
  type EmbeddingText,
  type EmbeddingResult,
  HypaProcessorV2,
} from "./hypamemoryv2";
import { type DisplayMode as ModalDisplayMode } from "src/lib/Others/HypaV3Modal/types";
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

export { createHypaV3Preset } from "./hypav3Preset";
export type { HypaV3Preset, HypaV3Settings } from "./hypav3Preset";

interface HypaV3Data {
  summaries: Summary[];
  categories?: { id: string; name: string }[];
  lastSelectedSummaries?: number[]; // legacy
  metrics?: {
    lastImportantSummaries: number[];
    lastRecentSummaries: number[];
    lastSimilarSummaries: number[];
    lastRandomSummaries: number[];
  };
  modalSettings?: {
    displayMode: ModalDisplayMode;
    displayRangeFrom: number;
    displayRangeTo: number;
    displayRecentCount: number;
    displayImportant: boolean;
    displaySelected: boolean;
  };
}

export interface SerializableHypaV3Data extends Omit<HypaV3Data, "summaries"> {
  summaries: SerializableSummary[];
}

interface Summary {
  text: string;
  chatMemos: Set<string>;
  isImportant: boolean;
  categoryId?: string;
  tags?: string[];
}

export interface SerializableSummary extends Omit<Summary, "chatMemos"> {
  chatMemos: string[];
}

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
const memoryPromptTag = "Past Events Summary";
const summarySeparator = "\n\n";

function splitBySeparator(text: string, separator: string): string[] {
  try {
    const regexMatch = separator.match(/^\/(.+)\/([gimuy]*)$/);
    if (regexMatch) {
      const [, pattern, flags] = regexMatch;
      return text.split(new RegExp(pattern, flags));
    }
    return text.split(new RegExp(separator));
  } catch {
    return text.split("\n\n");
  }
}

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
          maxResponse: db.maxResponse,
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
  const db = settingsStore.state;
  const settings = getCurrentHypaV3Preset().settings;

  // Validate settings
  if (settings.recentMemoryRatio + settings.similarMemoryRatio > 1) {
    return {
      currentTokens,
      chats,
      error: `${logPrefix} The sum of Recent Memory Ratio and Similar Memory Ratio is greater than 1.`,
    };
  }

  // Initial token correction
  currentTokens -= db.maxResponse;

  // Load existing hypa data if available
  const data: HypaV3Data = room.hypaV3Data
    ? toHypaV3Data(room.hypaV3Data)
    : {
        summaries: [],
      };

  // Clean orphaned summaries
  if (!settings.preserveOrphanedMemory) {
    cleanOrphanedSummary(chats, data);
  }

  // Chat history is immutable throughout HypaV3 processing. Tokenize it once so
  // all summary-window calculations reuse the same batched per-message costs.
  const chatTokenCounts = await tokenizer.tokenizeChatsDetailed(chats);

  // Determine starting index
  let startIdx = 0;

  if (data.summaries.length > 0) {
    const lastSummary = data.summaries.at(-1);
    const lastChatIndex = chats.findIndex(
      (chat) => chat.memo === [...lastSummary.chatMemos].at(-1),
    );

    if (lastChatIndex !== -1) {
      startIdx = lastChatIndex + 1;

      // Exclude tokens from summarized chats
      currentTokens -= chatTokenCounts
        .slice(0, lastChatIndex + 1)
        .reduce((total, tokens) => total + tokens, 0);
    }
  }

  console.log(logPrefix, "Starting index:", startIdx);

  // Reserve memory tokens
  const emptyMemoryTokens = await tokenizer.tokenizeChat({
    role: "system",
    content: wrapWithXml(memoryPromptTag, ""),
  });
  const memoryTokens = Math.floor(
    maxContextTokens * settings.memoryTokensRatio,
  );
  const shouldReserveMemoryTokens =
    data.summaries.length > 0 || currentTokens > maxContextTokens;
  let availableMemoryTokens = shouldReserveMemoryTokens
    ? memoryTokens - emptyMemoryTokens
    : 0;

  if (shouldReserveMemoryTokens) {
    currentTokens += memoryTokens;
    console.log(logPrefix, "Reserved memory tokens:", memoryTokens);
  }

  // If summarization is needed
  const summarizationMode = currentTokens > maxContextTokens;
  const targetTokens =
    maxContextTokens * (1 - settings.extraSummarizationRatio);
  const toSummarizeArray: OpenAIChat[][] = [];

  while (summarizationMode) {
    if (currentTokens <= targetTokens) {
      break;
    }

    if (chats.length - startIdx <= settings.queryChatCount) {
      if (currentTokens <= maxContextTokens) {
        break;
      } else {
        return {
          currentTokens,
          chats,
          error: `${logPrefix} Cannot summarize further: input token count (${currentTokens}) exceeds max context size (${maxContextTokens}), but minimum ${settings.queryChatCount} messages required.`,
          memory: toSerializableHypaV3Data(data),
        };
      }
    }

    const toSummarize: OpenAIChat[] = [];
    let toSummarizeTokens = 0;
    let currentIndex = startIdx;

    console.log(
      logPrefix,
      "Evaluating summarization batch:",
      "\nCurrent Tokens:",
      currentTokens,
      "\nMax Context Tokens:",
      maxContextTokens,
      "\nStart Index:",
      startIdx,
      "\nMax Chats Per Summary:",
      settings.maxChatsPerSummary,
    );

    while (
      toSummarize.length < settings.maxChatsPerSummary &&
      currentIndex < chats.length - settings.queryChatCount
    ) {
      const chat = chats[currentIndex];
      const chatTokens = chatTokenCounts[currentIndex];

      console.log(
        logPrefix,
        "Evaluating chat:",
        "\nIndex:",
        currentIndex,
        "\nRole:",
        chat.role,
        "\nContent:",
        "\n" + chat.content,
        "\nTokens:",
        chatTokens,
      );

      toSummarizeTokens += chatTokens;

      let shouldSummarize = true;

      if (
        chat.name === "example_user" ||
        chat.name === "example_assistant" ||
        chat.memo === "NewChatExample"
      ) {
        console.log(
          logPrefix,
          `Skipping example chat at index ${currentIndex}`,
        );
        shouldSummarize = false;
      }

      if (chat.memo === "NewChat") {
        console.log(logPrefix, `Skipping new chat at index ${currentIndex}`);
        shouldSummarize = false;
      }

      if (chat.content.trim().length === 0) {
        console.log(logPrefix, `Skipping empty chat at index ${currentIndex}`);
        shouldSummarize = false;
      }

      if (settings.doNotSummarizeUserMessage && chat.role === "user") {
        console.log(logPrefix, `Skipping user role at index ${currentIndex}`);
        shouldSummarize = false;
      }

      if (shouldSummarize) {
        toSummarize.push(chat);
      }

      currentIndex++;
    }

    // Stop summarization if further reduction would go below target tokens (unless we're over max tokens)
    if (
      currentTokens <= maxContextTokens &&
      currentTokens - toSummarizeTokens < targetTokens
    ) {
      console.log(
        logPrefix,
        "Stopping summarization:",
        `\ncurrentTokens(${currentTokens}) - toSummarizeTokens(${toSummarizeTokens}) < targetTokens(${targetTokens})`,
      );
      break;
    }

    // Collect summarization batch
    if (toSummarize.length > 0) {
      console.log(
        logPrefix,
        "Collecting summarization batch:",
        "\nTarget:",
        toSummarize,
      );

      toSummarizeArray.push([...toSummarize]);
    }

    currentTokens -= toSummarizeTokens;
    startIdx = currentIndex;
  }

  // Process all collected summarization tasks
  if (toSummarizeArray.length > 0) {
    const rateLimiter = new TaskRateLimiter({
      tasksPerMinute: settings.summarizationRequestsPerMinute,
      maxConcurrentTasks: settings.summarizationMaxConcurrent,
    });

    rateLimiter.taskQueueChangeCallback = (queuedCount) => {
      hypaV3ProgressStore.set({
        open: true,
        miniMsg: `${rateLimiter.queuedTaskCount}`,
        msg: `${logPrefix} Summarizing...`,
        subMsg: `${rateLimiter.queuedTaskCount} queued`,
      });
    };

    const summarizationTasks = toSummarizeArray.map(
      (item) => () => summarize(item, false, context),
    );

    // Start of performance measurement: summarize
    console.log(
      logPrefix,
      `Starting ${toSummarizeArray.length} summarization.`,
    );
    const summarizeStartTime = performance.now();

    const batchResult =
      await rateLimiter.executeBatch<string>(summarizationTasks);

    const summarizeEndTime = performance.now();
    console.debug(
      `${logPrefix} summarization completed in ${
        summarizeEndTime - summarizeStartTime
      }ms`,
    );
    // End of performance measurement: summarize

    hypaV3ProgressStore.set({
      open: false,
      miniMsg: "",
      msg: "",
      subMsg: "",
    });

    // Note:
    // We can't save some successful summaries to the DB temporarily
    // because don't know the actual summarization model name.
    // It is possible that the user can change the summarization model.
    for (let i = 0; i < batchResult.results.length; i++) {
      const result = batchResult.results[i];

      // Push consecutive successes
      if (!result.success || !result.data) {
        const errorMessage = !result.success
          ? result.error
          : "Empty summary returned";

        console.log(logPrefix, "Summarization failed:", `\n${errorMessage}`);

        return {
          currentTokens,
          chats,
          error: `${logPrefix} Summarization failed: ${errorMessage}`,
          memory: toSerializableHypaV3Data(data),
        };
      }

      const summaryText = result.data;

      data.summaries.push({
        text: summaryText,
        chatMemos: new Set(toSummarizeArray[i].map((chat) => chat.memo)),
        isImportant: false,
        categoryId: undefined,
        tags: [],
      });
    }
  }

  console.log(
    logPrefix,
    `${summarizationMode ? "Completed" : "Skipped"} summarization phase:`,
    "\nCurrent Tokens:",
    currentTokens,
    "\nMax Context Tokens:",
    maxContextTokens,
    "\nAvailable Memory Tokens:",
    availableMemoryTokens,
  );

  // Early return if no summaries
  if (data.summaries.length === 0) {
    const newChats: OpenAIChat[] = chats.slice(startIdx);

    console.log(
      logPrefix,
      "Exiting function:",
      "\nCurrent Tokens:",
      currentTokens,
      "\nAll chats, including memory prompt:",
      newChats,
      "\nMemory Data:",
      data,
    );

    return {
      currentTokens,
      chats: newChats,
      memory: toSerializableHypaV3Data(data),
    };
  }

  const summaryTokenCounts = await tokenizer.tokenizeChatsDetailed(
    data.summaries.map((summary) => ({
      role: "system",
      content: summary.text + summarySeparator,
    })),
  );
  const summaryTokenMap = new Map(
    data.summaries.map((summary, index) => [
      summary,
      summaryTokenCounts[index] ?? 0,
    ]),
  );

  const selectedSummaries: Summary[] = [];
  const randomMemoryRatio =
    1 - settings.recentMemoryRatio - settings.similarMemoryRatio;
  const selectedImportantSummaries: Summary[] = [];

  // Select important summaries
  {
    for (const summary of data.summaries) {
      if (summary.isImportant) {
        const summaryTokens = summaryTokenMap.get(summary) ?? 0;

        if (summaryTokens > availableMemoryTokens) {
          break;
        }

        selectedImportantSummaries.push(summary);

        availableMemoryTokens -= summaryTokens;
      }
    }

    selectedSummaries.push(...selectedImportantSummaries);

    console.log(
      logPrefix,
      "After important memory selection:",
      "\nSummary Count:",
      selectedImportantSummaries.length,
      "\nSummaries:",
      selectedImportantSummaries,
      "\nAvailable Memory Tokens:",
      availableMemoryTokens,
    );
  }

  // Select recent summaries
  const reservedRecentMemoryTokens = Math.floor(
    availableMemoryTokens * settings.recentMemoryRatio,
  );
  let consumedRecentMemoryTokens = 0;
  const selectedRecentSummaries: Summary[] = [];

  if (settings.recentMemoryRatio > 0) {
    // Target only summaries that haven't been selected yet
    const unusedSummaries = data.summaries.filter(
      (e) => !selectedSummaries.includes(e),
    );

    // Add one by one from the end
    for (let i = unusedSummaries.length - 1; i >= 0; i--) {
      const summary = unusedSummaries[i];
      const summaryTokens = summaryTokenMap.get(summary) ?? 0;

      if (
        summaryTokens + consumedRecentMemoryTokens >
        reservedRecentMemoryTokens
      ) {
        break;
      }

      selectedRecentSummaries.push(summary);
      consumedRecentMemoryTokens += summaryTokens;
    }

    selectedSummaries.push(...selectedRecentSummaries);

    console.log(
      logPrefix,
      "After recent memory selection:",
      "\nSummary Count:",
      selectedRecentSummaries.length,
      "\nSummaries:",
      selectedRecentSummaries,
      "\nReserved Tokens:",
      reservedRecentMemoryTokens,
      "\nConsumed Tokens:",
      consumedRecentMemoryTokens,
    );
  }

  // Select similar summaries
  let reservedSimilarMemoryTokens = Math.floor(
    availableMemoryTokens * settings.similarMemoryRatio,
  );
  let consumedSimilarMemoryTokens = 0;
  const selectedSimilarSummaries: Summary[] = [];

  if (settings.similarMemoryRatio > 0) {
    // Utilize unused token space from recent selection
    if (randomMemoryRatio <= 0) {
      const unusedRecentTokens =
        reservedRecentMemoryTokens - consumedRecentMemoryTokens;

      reservedSimilarMemoryTokens += unusedRecentTokens;
      console.log(
        logPrefix,
        "Additional available token space for similar memory:",
        "\nFrom recent:",
        unusedRecentTokens,
      );
    }

    // Target only summaries that haven't been selected yet
    const unusedSummaries = data.summaries.filter(
      (e) => !selectedSummaries.includes(e),
    );

    // Dynamically generate embedding texts
    const ebdTexts: EmbeddingText<Summary>[] = unusedSummaries.flatMap(
      (summary, summaryIndex) => {
        const splitted = splitBySeparator(
          summary.text,
          settings.summaryChunkSeparator,
        ).filter((e) => e.trim().length > 0);

        return splitted.map((chunk, chunkIndex) => ({
          id: `${summaryIndex}-${chunkIndex}`,
          content: chunk.trim(),
          metadata: summary,
        }));
      },
    );

    // Initialize embedding processor
    const processor = new HypaProcessorV2<Summary>({
      serverIndexId: `hypav3-exp:${char.chaId}:${room.id}`,
      rateLimiter: new TaskRateLimiter({
        tasksPerMinute: settings.embeddingRequestsPerMinute,
        maxConcurrentTasks: settings.embeddingMaxConcurrent,
      }),
    });

    processor.progressCallback = (queuedCount) => {
      hypaV3ProgressStore.set({
        open: true,
        miniMsg: `${queuedCount}`,
        msg: `${logPrefix} Similarity searching...`,
        subMsg: `${queuedCount} queued`,
      });
    };

    try {
      // Start of performance measurement: addTexts
      console.log(
        `${logPrefix} Starting addTexts with ${ebdTexts.length} chunks`,
      );
      const addStartTime = performance.now();

      // Add EmbeddingTexts to processor for similarity search
      await processor.addTexts(ebdTexts);

      const addEndTime = performance.now();
      console.debug(
        `${logPrefix} addTexts completed in ${addEndTime - addStartTime}ms`,
      );
      // End of performance measurement: addTexts
    } catch (error) {
      return {
        currentTokens,
        chats,
        error: `${logPrefix} Similarity search failed: ${error}`,
        memory: toSerializableHypaV3Data(data),
      };
    } finally {
      hypaV3ProgressStore.set({
        open: false,
        miniMsg: "",
        msg: "",
        subMsg: "",
      });
    }

    const recentChats = chats
      .slice(-settings.queryChatCount)
      .filter((chat) => chat.content.trim().length > 0);

    const queries = recentChats
      .map((chat, index) => {
        const subQueries = chat.content
          .split("\n\n")
          .filter((e) => e.trim().length > 0);
        const weight =
          (index + 1) /
          ((recentChats.length * (recentChats.length + 1)) / 2) /
          subQueries.length;

        return subQueries.map((content) => ({
          content,
          weight,
        }));
      })
      .flat();

    if (queries.length > 0) {
      try {
        // Start of performance measurement: similarity search
        console.log(
          `${logPrefix} Starting similarity search with ${recentChats.length} queries`,
        );
        const searchStartTime = performance.now();

        const batchScoredResults = await processor.similaritySearchScoredBatch(
          queries.map((query) => query.content),
        );

        /*
                // Hybrid search may be implemented in the future
                await keywordEngine.addDocuments(
                  Array.from(processor.vectors.values())
                );
        
                const batchkeywordResults = [];
                for (const query of queries) {
                  batchkeywordResults.push(await keywordEngine.search(query));
                }
        
                const batchHybridResults = [];
                for (let i = 0; i < queries.length; i++) {
                  const [semanticResults] = batchScoredResults[i];
                  const keywordResults = batchkeywordResults[i];
        
                  batchHybridResults.push(
                    simpleRRF<EmbeddingResult<Summary>>([
                      semanticResults,
                      keywordResults,
                    ])
                  );
                }
                */

        const searchEndTime = performance.now();
        console.debug(
          `${logPrefix} Similarity search completed in ${
            searchEndTime - searchStartTime
          }ms`,
        );
        // End of performance measurement: similarity search

        const rankedChunks = simpleCC<EmbeddingResult<Summary>>(
          batchScoredResults,
          (listIndex) => queries[listIndex].weight,
        );

        const rankedSummaries = childToParentRRF<
          EmbeddingResult<Summary>,
          Summary
        >(rankedChunks, (chunk) => chunk.metadata);

        while (rankedSummaries.length > 0) {
          const summary = rankedSummaries.shift();
          const summaryTokens = summaryTokenMap.get(summary) ?? 0;

          if (
            summaryTokens + consumedSimilarMemoryTokens >
            reservedSimilarMemoryTokens
          ) {
            console.log(
              logPrefix,
              "Stopping similar memory selection:",
              `\nconsumedSimilarMemoryTokens(${consumedSimilarMemoryTokens}) + summaryTokens(${summaryTokens}) > reservedSimilarMemoryTokens(${reservedSimilarMemoryTokens})`,
            );
            break;
          }

          selectedSimilarSummaries.push(summary);
          consumedSimilarMemoryTokens += summaryTokens;
        }

        selectedSummaries.push(...selectedSimilarSummaries);
      } catch (error) {
        return {
          currentTokens,
          chats,
          error: `${logPrefix} Similarity search failed: ${error}`,
          memory: toSerializableHypaV3Data(data),
        };
      } finally {
        hypaV3ProgressStore.set({
          open: false,
          miniMsg: "",
          msg: "",
          subMsg: "",
        });
      }
    }

    console.log(
      logPrefix,
      "After similar memory selection:",
      "\nSummary Count:",
      selectedSimilarSummaries.length,
      "\nSummaries:",
      selectedSimilarSummaries,
      "\nReserved Tokens:",
      reservedSimilarMemoryTokens,
      "\nConsumed Tokens:",
      consumedSimilarMemoryTokens,
    );
  }

  // Select random summaries
  let reservedRandomMemoryTokens = Math.floor(
    availableMemoryTokens * randomMemoryRatio,
  );
  let consumedRandomMemoryTokens = 0;
  const selectedRandomSummaries: Summary[] = [];

  if (randomMemoryRatio > 0) {
    // Utilize unused token space from recent and similar selection
    const unusedRecentTokens =
      reservedRecentMemoryTokens - consumedRecentMemoryTokens;
    const unusedSimilarTokens =
      reservedSimilarMemoryTokens - consumedSimilarMemoryTokens;

    reservedRandomMemoryTokens += unusedRecentTokens + unusedSimilarTokens;
    console.log(
      logPrefix,
      "Additional available token space for random memory:",
      "\nFrom recent:",
      unusedRecentTokens,
      "\nFrom similar:",
      unusedSimilarTokens,
      "\nTotal added:",
      unusedRecentTokens + unusedSimilarTokens,
    );

    // Target only summaries that haven't been selected yet
    const unusedSummaries = data.summaries
      .filter((e) => !selectedSummaries.includes(e))
      .sort(() => Math.random() - 0.5); // Random shuffle

    for (const summary of unusedSummaries) {
      const summaryTokens = summaryTokenMap.get(summary) ?? 0;

      if (
        summaryTokens + consumedRandomMemoryTokens >
        reservedRandomMemoryTokens
      ) {
        // Trying to select more random memory
        continue;
      }

      selectedRandomSummaries.push(summary);
      consumedRandomMemoryTokens += summaryTokens;
    }

    selectedSummaries.push(...selectedRandomSummaries);

    console.log(
      logPrefix,
      "After random memory selection:",
      "\nSummary Count:",
      selectedRandomSummaries.length,
      "\nSummaries:",
      selectedRandomSummaries,
      "\nReserved Tokens:",
      reservedRandomMemoryTokens,
      "\nConsumed Tokens:",
      consumedRandomMemoryTokens,
    );
  }

  // Sort selected summaries chronologically (by index)
  selectedSummaries.sort(
    (a, b) => data.summaries.indexOf(a) - data.summaries.indexOf(b),
  );

  // Generate final memory prompt
  const memory = wrapWithXml(
    memoryPromptTag,
    selectedSummaries.map((e) => e.text).join(summarySeparator),
  );
  const realMemoryTokens = await tokenizer.tokenizeChat({
    role: "system",
    content: memory,
  });

  // Release reserved memory tokens
  if (shouldReserveMemoryTokens) {
    currentTokens -= memoryTokens;
  }

  currentTokens += realMemoryTokens;

  console.log(
    logPrefix,
    "Final memory selection:",
    "\nSummary Count:",
    selectedSummaries.length,
    "\nSummaries:",
    selectedSummaries,
    "\nReal Memory Tokens:",
    realMemoryTokens,
    "\nAvailable Memory Tokens:",
    availableMemoryTokens,
  );

  if (currentTokens > maxContextTokens) {
    throw new Error(
      `Unexpected error: input token count (${currentTokens}) exceeds max context size (${maxContextTokens})`,
    );
  }

  // Save last selected summaries
  data.metrics = {
    lastImportantSummaries: selectedImportantSummaries.map((selected) =>
      data.summaries.findIndex((sum) => sum === selected),
    ),
    lastRecentSummaries: selectedRecentSummaries.map((selected) =>
      data.summaries.findIndex((sum) => sum === selected),
    ),
    lastSimilarSummaries: selectedSimilarSummaries.map((selected) =>
      data.summaries.findIndex((sum) => sum === selected),
    ),
    lastRandomSummaries: selectedRandomSummaries.map((selected) =>
      data.summaries.findIndex((sum) => sum === selected),
    ),
  };

  const newChats: OpenAIChat[] = [
    {
      role: "system",
      content: memory,
      memo: "supaMemory",
    },
    ...chats.slice(startIdx),
  ];

  console.log(
    logPrefix,
    "Exiting function:",
    "\nCurrent Tokens:",
    currentTokens,
    "\nAll chats, including memory prompt:",
    newChats,
    "\nMemory Data:",
    data,
  );

  return {
    currentTokens,
    chats: newChats,
    memory: toSerializableHypaV3Data(data),
  };
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
  const db = settingsStore.state;
  const settings = getCurrentHypaV3Preset().settings;

  // Validate settings
  if (settings.recentMemoryRatio + settings.similarMemoryRatio > 1) {
    return {
      currentTokens,
      chats,
      error: `${logPrefix} The sum of Recent Memory Ratio and Similar Memory Ratio is greater than 1.`,
    };
  }

  // Initial token correction
  currentTokens -= db.maxResponse;

  // Load existing hypa data if available
  const data: HypaV3Data = room.hypaV3Data
    ? toHypaV3Data(room.hypaV3Data)
    : {
        summaries: [],
      };

  // Clean orphaned summaries
  if (!settings.preserveOrphanedMemory) {
    cleanOrphanedSummary(chats, data);
  }

  // Chat history is immutable throughout HypaV3 processing. Tokenize it once so
  // all summary-window calculations reuse the same batched per-message costs.
  const chatTokenCounts = await tokenizer.tokenizeChatsDetailed(chats);

  // Determine starting index
  let startIdx = 0;

  if (data.summaries.length > 0) {
    const lastSummary = data.summaries.at(-1);
    const lastChatIndex = chats.findIndex(
      (chat) => chat.memo === [...lastSummary.chatMemos].at(-1),
    );

    if (lastChatIndex !== -1) {
      startIdx = lastChatIndex + 1;

      // Exclude tokens from summarized chats
      currentTokens -= chatTokenCounts
        .slice(0, lastChatIndex + 1)
        .reduce((total, tokens) => total + tokens, 0);
    }
  }

  console.log(logPrefix, "Starting index:", startIdx);

  // Reserve memory tokens
  const emptyMemoryTokens = await tokenizer.tokenizeChat({
    role: "system",
    content: wrapWithXml(memoryPromptTag, ""),
  });
  const memoryTokens = Math.floor(
    maxContextTokens * settings.memoryTokensRatio,
  );
  const shouldReserveEmptyMemoryTokens =
    data.summaries.length === 0 &&
    currentTokens + emptyMemoryTokens <= maxContextTokens;
  let availableMemoryTokens = shouldReserveEmptyMemoryTokens
    ? 0
    : memoryTokens - emptyMemoryTokens;

  if (shouldReserveEmptyMemoryTokens) {
    currentTokens += emptyMemoryTokens;
    console.log(logPrefix, "Reserved empty memory tokens:", emptyMemoryTokens);
  } else {
    currentTokens += memoryTokens;
    console.log(logPrefix, "Reserved max memory tokens:", memoryTokens);
  }

  // If summarization is needed
  const summarizationMode = currentTokens > maxContextTokens;
  const targetTokens =
    maxContextTokens * (1 - settings.extraSummarizationRatio);

  while (summarizationMode) {
    if (currentTokens <= targetTokens) {
      break;
    }

    if (chats.length - startIdx <= settings.queryChatCount) {
      if (currentTokens <= maxContextTokens) {
        break;
      } else {
        return {
          currentTokens,
          chats,
          error: `${logPrefix} Cannot summarize further: input token count (${currentTokens}) exceeds max context size (${maxContextTokens}), but minimum ${settings.queryChatCount} messages required.`,
          memory: toSerializableHypaV3Data(data),
        };
      }
    }

    const toSummarize: OpenAIChat[] = [];
    const endIdx = Math.min(
      startIdx + settings.maxChatsPerSummary,
      chats.length - settings.queryChatCount,
    );
    let toSummarizeTokens = 0;

    console.log(
      logPrefix,
      "Evaluating summarization batch:",
      "\nCurrent Tokens:",
      currentTokens,
      "\nMax Context Tokens:",
      maxContextTokens,
      "\nStart Index:",
      startIdx,
      "\nEnd Index:",
      endIdx,
      "\nChat Count:",
      endIdx - startIdx,
      "\nMax Chats Per Summary:",
      settings.maxChatsPerSummary,
    );

    for (let i = startIdx; i < endIdx; i++) {
      const chat = chats[i];
      const chatTokens = chatTokenCounts[i];

      console.log(
        logPrefix,
        "Evaluating chat:",
        "\nIndex:",
        i,
        "\nRole:",
        chat.role,
        "\nContent:",
        "\n" + chat.content,
        "\nTokens:",
        chatTokens,
      );

      toSummarizeTokens += chatTokens;

      if (
        chat.name === "example_user" ||
        chat.name === "example_assistant" ||
        chat.memo === "NewChatExample"
      ) {
        console.log(logPrefix, `Skipping example chat at index ${i}`);
        continue;
      }

      if (chat.memo === "NewChat") {
        console.log(logPrefix, `Skipping new chat at index ${i}`);
        continue;
      }

      if (chat.content.trim().length === 0) {
        console.log(logPrefix, `Skipping empty chat at index ${i}`);
        continue;
      }

      if (settings.doNotSummarizeUserMessage && chat.role === "user") {
        console.log(logPrefix, `Skipping user role at index ${i}`);
        continue;
      }

      toSummarize.push(chat);
    }

    // Stop summarization if further reduction would go below target tokens (unless we're over max tokens)
    if (
      currentTokens <= maxContextTokens &&
      currentTokens - toSummarizeTokens < targetTokens
    ) {
      console.log(
        logPrefix,
        "Stopping summarization:",
        `\ncurrentTokens(${currentTokens}) - toSummarizeTokens(${toSummarizeTokens}) < targetTokens(${targetTokens})`,
      );
      break;
    }

    // Attempt summarization
    if (toSummarize.length > 0) {
      console.log(
        logPrefix,
        "Attempting summarization:",
        "\nTarget:",
        toSummarize,
      );

      try {
        const summarizeResult = await summarize(toSummarize, false, context);

        data.summaries.push({
          text: summarizeResult,
          chatMemos: new Set(toSummarize.map((chat) => chat.memo)),
          isImportant: false,
          categoryId: undefined,
          tags: [],
        });
      } catch (error) {
        console.log(logPrefix, "Summarization failed:", `\n${error}`);

        return {
          currentTokens,
          chats,
          error: `${logPrefix} Summarization failed: ${error}`,
          memory: toSerializableHypaV3Data(data),
        };
      }
    }

    currentTokens -= toSummarizeTokens;
    startIdx = endIdx;
  }

  console.log(
    logPrefix,
    `${summarizationMode ? "Completed" : "Skipped"} summarization phase:`,
    "\nCurrent Tokens:",
    currentTokens,
    "\nMax Context Tokens:",
    maxContextTokens,
    "\nAvailable Memory Tokens:",
    availableMemoryTokens,
  );

  // Early return if no summaries
  if (data.summaries.length === 0) {
    // Generate final memory prompt
    const memory = wrapWithXml(memoryPromptTag, "");

    const newChats: OpenAIChat[] = [
      {
        role: "system",
        content: memory,
        memo: "supaMemory",
      },
      ...chats.slice(startIdx),
    ];

    console.log(
      logPrefix,
      "Exiting function:",
      "\nCurrent Tokens:",
      currentTokens,
      "\nAll chats, including memory prompt:",
      newChats,
      "\nMemory Data:",
      data,
    );

    return {
      currentTokens,
      chats: newChats,
      memory: toSerializableHypaV3Data(data),
    };
  }

  const summaryTokenCounts = await tokenizer.tokenizeChatsDetailed(
    data.summaries.map((summary) => ({
      role: "system",
      content: summary.text + summarySeparator,
    })),
  );
  const summaryTokenMap = new Map(
    data.summaries.map((summary, index) => [
      summary,
      summaryTokenCounts[index] ?? 0,
    ]),
  );

  const selectedSummaries: Summary[] = [];
  const randomMemoryRatio =
    1 - settings.recentMemoryRatio - settings.similarMemoryRatio;
  const selectedImportantSummaries: Summary[] = [];

  // Select important summaries
  {
    for (const summary of data.summaries) {
      if (summary.isImportant) {
        const summaryTokens = summaryTokenMap.get(summary) ?? 0;

        if (summaryTokens > availableMemoryTokens) {
          break;
        }

        selectedImportantSummaries.push(summary);

        availableMemoryTokens -= summaryTokens;
      }
    }

    selectedSummaries.push(...selectedImportantSummaries);

    console.log(
      logPrefix,
      "After important memory selection:",
      "\nSummary Count:",
      selectedImportantSummaries.length,
      "\nSummaries:",
      selectedImportantSummaries,
      "\nAvailable Memory Tokens:",
      availableMemoryTokens,
    );
  }

  // Select recent summaries
  const reservedRecentMemoryTokens = Math.floor(
    availableMemoryTokens * settings.recentMemoryRatio,
  );
  let consumedRecentMemoryTokens = 0;
  const selectedRecentSummaries: Summary[] = [];

  if (settings.recentMemoryRatio > 0) {
    // Target only summaries that haven't been selected yet
    const unusedSummaries = data.summaries.filter(
      (e) => !selectedSummaries.includes(e),
    );

    // Add one by one from the end
    for (let i = unusedSummaries.length - 1; i >= 0; i--) {
      const summary = unusedSummaries[i];
      const summaryTokens = summaryTokenMap.get(summary) ?? 0;

      if (
        summaryTokens + consumedRecentMemoryTokens >
        reservedRecentMemoryTokens
      ) {
        break;
      }

      selectedRecentSummaries.push(summary);
      consumedRecentMemoryTokens += summaryTokens;
    }

    selectedSummaries.push(...selectedRecentSummaries);

    console.log(
      logPrefix,
      "After recent memory selection:",
      "\nSummary Count:",
      selectedRecentSummaries.length,
      "\nSummaries:",
      selectedRecentSummaries,
      "\nReserved Tokens:",
      reservedRecentMemoryTokens,
      "\nConsumed Tokens:",
      consumedRecentMemoryTokens,
    );
  }

  // Select similar summaries
  let reservedSimilarMemoryTokens = Math.floor(
    availableMemoryTokens * settings.similarMemoryRatio,
  );
  let consumedSimilarMemoryTokens = 0;
  const selectedSimilarSummaries: Summary[] = [];

  if (settings.similarMemoryRatio > 0) {
    // Utilize unused token space from recent selection
    if (randomMemoryRatio <= 0) {
      const unusedRecentTokens =
        reservedRecentMemoryTokens - consumedRecentMemoryTokens;

      reservedSimilarMemoryTokens += unusedRecentTokens;
      console.log(
        logPrefix,
        "Additional available token space for similar memory:",
        "\nFrom recent:",
        unusedRecentTokens,
      );
    }

    // Target only summaries that haven't been selected yet
    const unusedSummaries = data.summaries.filter(
      (e) => !selectedSummaries.includes(e),
    );

    // Dynamically generate summary chunks
    const summaryChunks: SummaryChunk[] = [];

    unusedSummaries.forEach((summary) => {
      const splitted = splitBySeparator(
        summary.text,
        settings.summaryChunkSeparator,
      ).filter((e) => e.trim().length > 0);

      summaryChunks.push(
        ...splitted.map((e) => ({
          text: e.trim(),
          summary,
        })),
      );
    });

    // Initialize embedding processor
    const processor = new HypaProcesserEx(
      db.hypaModel,
      undefined,
      `hypav3:${char.chaId}:${room.id}`,
    );
    processor.oaikey = db.supaMemoryKey;

    // Add summaryChunks to processor for similarity search
    try {
      await processor.addSummaryChunks(summaryChunks);
    } catch (error) {
      return {
        currentTokens,
        chats,
        error: `${logPrefix} Similarity search failed: ${error}`,
        memory: toSerializableHypaV3Data(data),
      };
    }

    const recentChats = chats
      .slice(-settings.queryChatCount)
      .filter((chat) => chat.content.trim().length > 0);

    if (recentChats.length > 0) {
      // Raw recent chat search
      const queries = recentChats.map((chat) => chat.content);

      if (settings.enableSimilarityCorrection && recentChats.length > 1) {
        // Raw + Summarized recent chat search
        // Summarizing is meaningful when there are more than 2 recent chats

        // Attempt summarization
        console.log(
          logPrefix,
          "Attempting summarization for similarity search:",
          "\nTarget:",
          recentChats,
        );

        try {
          const summarizeResult = await summarize(recentChats, false, context);

          queries.push(summarizeResult);
        } catch (error) {
          console.log(logPrefix, "Summarization failed:", `\n${error}`);

          return {
            currentTokens,
            chats,
            error: `${logPrefix} Summarization failed: ${error}`,
            memory: toSerializableHypaV3Data(data),
          };
        }
      }

      try {
        const scoredLists: [SummaryChunk, number][][] = [];

        for (let i = 0; i < queries.length; i++) {
          const query = queries[i];
          const scoredChunks = await processor.similaritySearchScoredEx(query);

          scoredLists.push(scoredChunks);
        }

        const rankedChunks = simpleCC<SummaryChunk>(
          scoredLists,
          (listIndex, totalLists) => {
            return (listIndex + 1) / ((totalLists * (totalLists + 1)) / 2);
          },
        );

        const rankedSummaries = childToParentRRF<SummaryChunk, Summary>(
          rankedChunks,
          (chunk) => chunk.summary,
        );

        while (rankedSummaries.length > 0) {
          const summary = rankedSummaries.shift();
          const summaryTokens = summaryTokenMap.get(summary) ?? 0;

          if (
            summaryTokens + consumedSimilarMemoryTokens >
            reservedSimilarMemoryTokens
          ) {
            console.log(
              logPrefix,
              "Stopping similar memory selection:",
              `\nconsumedSimilarMemoryTokens(${consumedSimilarMemoryTokens}) + summaryTokens(${summaryTokens}) > reservedSimilarMemoryTokens(${reservedSimilarMemoryTokens})`,
            );
            break;
          }

          selectedSimilarSummaries.push(summary);
          consumedSimilarMemoryTokens += summaryTokens;
        }

        selectedSummaries.push(...selectedSimilarSummaries);
      } catch (error) {
        return {
          currentTokens,
          chats,
          error: `${logPrefix} Similarity search failed: ${error}`,
          memory: toSerializableHypaV3Data(data),
        };
      }
    }

    console.log(
      logPrefix,
      "After similar memory selection:",
      "\nSummary Count:",
      selectedSimilarSummaries.length,
      "\nSummaries:",
      selectedSimilarSummaries,
      "\nReserved Tokens:",
      reservedSimilarMemoryTokens,
      "\nConsumed Tokens:",
      consumedSimilarMemoryTokens,
    );
  }

  // Select random summaries
  let reservedRandomMemoryTokens = Math.floor(
    availableMemoryTokens * randomMemoryRatio,
  );
  let consumedRandomMemoryTokens = 0;
  const selectedRandomSummaries: Summary[] = [];

  if (randomMemoryRatio > 0) {
    // Utilize unused token space from recent and similar selection
    const unusedRecentTokens =
      reservedRecentMemoryTokens - consumedRecentMemoryTokens;
    const unusedSimilarTokens =
      reservedSimilarMemoryTokens - consumedSimilarMemoryTokens;

    reservedRandomMemoryTokens += unusedRecentTokens + unusedSimilarTokens;
    console.log(
      logPrefix,
      "Additional available token space for random memory:",
      "\nFrom recent:",
      unusedRecentTokens,
      "\nFrom similar:",
      unusedSimilarTokens,
      "\nTotal added:",
      unusedRecentTokens + unusedSimilarTokens,
    );

    // Target only summaries that haven't been selected yet
    const unusedSummaries = data.summaries
      .filter((e) => !selectedSummaries.includes(e))
      .sort(() => Math.random() - 0.5); // Random shuffle

    for (const summary of unusedSummaries) {
      const summaryTokens = summaryTokenMap.get(summary) ?? 0;

      if (
        summaryTokens + consumedRandomMemoryTokens >
        reservedRandomMemoryTokens
      ) {
        // Trying to select more random memory
        continue;
      }

      selectedRandomSummaries.push(summary);
      consumedRandomMemoryTokens += summaryTokens;
    }

    selectedSummaries.push(...selectedRandomSummaries);

    console.log(
      logPrefix,
      "After random memory selection:",
      "\nSummary Count:",
      selectedRandomSummaries.length,
      "\nSummaries:",
      selectedRandomSummaries,
      "\nReserved Tokens:",
      reservedRandomMemoryTokens,
      "\nConsumed Tokens:",
      consumedRandomMemoryTokens,
    );
  }

  // Sort selected summaries chronologically (by index)
  selectedSummaries.sort(
    (a, b) => data.summaries.indexOf(a) - data.summaries.indexOf(b),
  );

  // Generate final memory prompt
  const memory = wrapWithXml(
    memoryPromptTag,
    selectedSummaries.map((e) => e.text).join(summarySeparator),
  );
  const realMemoryTokens = await tokenizer.tokenizeChat({
    role: "system",
    content: memory,
  });

  // Release reserved memory tokens
  if (shouldReserveEmptyMemoryTokens) {
    currentTokens -= emptyMemoryTokens;
  } else {
    currentTokens -= memoryTokens;
  }

  currentTokens += realMemoryTokens;

  console.log(
    logPrefix,
    "Final memory selection:",
    "\nSummary Count:",
    selectedSummaries.length,
    "\nSummaries:",
    selectedSummaries,
    "\nReal Memory Tokens:",
    realMemoryTokens,
    "\nAvailable Memory Tokens:",
    availableMemoryTokens,
  );

  if (currentTokens > maxContextTokens) {
    throw new Error(
      `Unexpected error: input token count (${currentTokens}) exceeds max context size (${maxContextTokens})`,
    );
  }

  // Save last selected summaries
  data.metrics = {
    lastImportantSummaries: selectedImportantSummaries.map((selected) =>
      data.summaries.findIndex((sum) => sum === selected),
    ),
    lastRecentSummaries: selectedRecentSummaries.map((selected) =>
      data.summaries.findIndex((sum) => sum === selected),
    ),
    lastSimilarSummaries: selectedSimilarSummaries.map((selected) =>
      data.summaries.findIndex((sum) => sum === selected),
    ),
    lastRandomSummaries: selectedRandomSummaries.map((selected) =>
      data.summaries.findIndex((sum) => sum === selected),
    ),
  };

  const newChats: OpenAIChat[] = [
    {
      role: "system",
      content: memory,
      memo: "supaMemory",
    },
    ...chats.slice(startIdx),
  ];

  console.log(
    logPrefix,
    "Exiting function:",
    "\nCurrent Tokens:",
    currentTokens,
    "\nAll chats, including memory prompt:",
    newChats,
    "\nMemory Data:",
    data,
  );

  return {
    currentTokens,
    chats: newChats,
    memory: toSerializableHypaV3Data(data),
  };
}

function toHypaV3Data(serialData: SerializableHypaV3Data): HypaV3Data {
  // Remove legacy property
  const { lastSelectedSummaries, ...restData } = serialData;

  return {
    ...restData,
    summaries: serialData.summaries.map((summary) => ({
      ...summary,
      // Convert null back to undefined (JSON serialization converts undefined to null)
      chatMemos: new Set(
        summary.chatMemos.map((memo) => (memo === null ? undefined : memo)),
      ),
    })),
  };
}

function toSerializableHypaV3Data(data: HypaV3Data): SerializableHypaV3Data {
  return {
    ...data,
    summaries: data.summaries.map((summary) => ({
      ...summary,
      chatMemos: [...summary.chatMemos],
    })),
  };
}

function cleanOrphanedSummary(chats: OpenAIChat[], data: HypaV3Data): void {
  // Collect all memos from current chats
  const currentChatMemos = new Set(chats.map((chat) => chat.memo));
  const originalLength = data.summaries.length;

  // Filter summaries - keep only those whose chatMemos are subset of current chat memos
  data.summaries = data.summaries.filter((summary) => {
    return isSubset(summary.chatMemos, currentChatMemos);
  });

  const removedCount = originalLength - data.summaries.length;

  if (removedCount > 0) {
    console.log(logPrefix, `Cleaned ${removedCount} orphaned summaries.`);
  }
}

function isSubset(subset: Set<string>, superset: Set<string>): boolean {
  for (const elem of subset) {
    if (!superset.has(elem)) {
      return false;
    }
  }

  return true;
}

function wrapWithXml(tag: string, content: string): string {
  return `<${tag}>\n${content}\n</${tag}>`;
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

  console.log(logPrefix, `Using ax model ${db.subModel} for summarization.`);

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

function simpleCC<T>(
  scoredLists: [T, number][][],
  weightFunc?: (listIndex: number, totalLists: number) => number,
): T[] {
  const scores = new Map<T, number>();

  for (let listIndex = 0; listIndex < scoredLists.length; listIndex++) {
    const list = scoredLists[listIndex];
    const weight = weightFunc
      ? weightFunc(listIndex, scoredLists.length)
      : 1 / scoredLists.length;

    for (const [item, score] of list) {
      scores.set(item, (scores.get(item) || 0) + score * weight);
    }
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([item]) => item);
}

function simpleRRF<T>(rankedLists: T[][], k: number = 60): T[] {
  const scores = new Map<T, number>();

  for (let listIndex = 0; listIndex < rankedLists.length; listIndex++) {
    const list = rankedLists[listIndex];

    for (let itemIndex = 0; itemIndex < list.length; itemIndex++) {
      const item = list[itemIndex];
      const rank = itemIndex + 1;
      const rrfTerm = 1 / (k + rank);

      scores.set(item, (scores.get(item) || 0) + rrfTerm);
    }
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([item]) => item);
}

function childToParentRRF<C, P>(
  rankedChildren: C[],
  parentFunc: (child: C) => P,
  k: number = 60,
): P[] {
  const scores = new Map<P, number>();

  for (let childIndex = 0; childIndex < rankedChildren.length; childIndex++) {
    const child = rankedChildren[childIndex];
    const parent = parentFunc(child);
    const rank = childIndex + 1;
    const rrfTerm = 1 / (k + rank);

    scores.set(parent, (scores.get(parent) || 0) + rrfTerm);
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([parent]) => parent);
}

function normalizeScores<T>(scoredList: [T, number][]): [T, number][] {
  if (scoredList.length === 0) {
    return [];
  }

  const scores = scoredList.map(([, score]) => score);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);

  if (minScore === maxScore) {
    if (minScore === 0) {
      return scoredList.map(([item]) => [item, 0]);
    }

    return scoredList.map(([item]) => [item, 1]);
  }

  return scoredList.map(([item, score]) => {
    const normalizedScore = (score - minScore) / (maxScore - minScore);
    return [item, normalizedScore];
  });
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
      const scoredTexts = await this.similaritySearchVectorWithScore(queryVector);
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
