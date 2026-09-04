import {
  childToParentRRF,
  cleanOrphanedSummaries,
  combineScoredLists,
  deserializeHypaV3Data,
  serializeHypaV3Data,
} from "./core.js";
import type {
  HypaV3Data,
  HypaV3Settings,
  HypaV3Summary,
  SerializableHypaV3Data,
} from "./types.js";

export interface HypaV3Message {
  role: "system" | "user" | "assistant" | "function";
  content: string;
  name?: string;
  memo?: string;
}

export interface HypaV3Tokenizer {
  tokenizeChat(chat: HypaV3Message): Promise<number>;
  tokenizeChatsDetailed(chats: HypaV3Message[]): Promise<number[]>;
}

export interface HypaV3Progress {
  open: boolean;
  miniMsg: string;
  msg: string;
  subMsg: string;
}

export interface HypaV3RateLimiter {
  queuedTaskCount: number;
  taskQueueChangeCallback: ((queuedCount: number) => void) | null;
  executeBatch<T>(tasks: Array<() => Promise<T>>): Promise<{
    results: Array<{
      success: boolean;
      data?: T;
      error?: unknown;
    }>;
  }>;
}

export interface HypaV3EmbeddingText<Metadata> {
  id: string;
  content: string;
  metadata: Metadata;
}

export interface HypaV3EmbeddingResult<
  Metadata,
> extends HypaV3EmbeddingText<Metadata> {
  embedding: number[] | Float32Array;
}

export interface HypaV3EmbeddingProcessor<Metadata> {
  progressCallback: (queuedCount: number) => void;
  addTexts(texts: HypaV3EmbeddingText<Metadata>[]): Promise<void>;
  similaritySearchScoredBatch(
    queries: string[],
  ): Promise<Array<Array<[HypaV3EmbeddingResult<Metadata>, number]>>>;
}

export interface HypaV3SummaryChunk {
  text: string;
  summary: HypaV3Summary;
}

export interface HypaV3LegacyEmbeddingProcessor {
  addSummaryChunks(chunks: HypaV3SummaryChunk[]): Promise<void>;
  similaritySearchScoredEx(
    query: string,
  ): Promise<Array<[HypaV3SummaryChunk, number]>>;
}

export interface HypaV3EngineInput {
  chats: HypaV3Message[];
  currentTokens: number;
  maxContextTokens: number;
  maxResponseTokens: number;
  memory?: SerializableHypaV3Data;
  conversationId?: string;
  characterId: string;
  settings: HypaV3Settings;
  tokenizer: HypaV3Tokenizer;
}

export interface HypaV3EngineResult {
  currentTokens: number;
  chats: HypaV3Message[];
  error?: string;
  memory?: SerializableHypaV3Data;
}

export interface HypaV3Runtime {
  createRateLimiter(options: {
    tasksPerMinute: number;
    maxConcurrentTasks: number;
  }): HypaV3RateLimiter;
  createEmbeddingProcessor<Metadata>(options: {
    serverIndexId: string;
    rateLimiter: HypaV3RateLimiter;
  }): HypaV3EmbeddingProcessor<Metadata>;
  createLegacyEmbeddingProcessor(options: {
    serverIndexId: string;
  }): HypaV3LegacyEmbeddingProcessor;
  summarize(messages: HypaV3Message[], isResummarize: boolean): Promise<string>;
  onProgress(progress: HypaV3Progress): void;
  random(): number;
}

type Summary = HypaV3Summary;
type EmbeddingText<Metadata> = HypaV3EmbeddingText<Metadata>;
type EmbeddingResult<Metadata> = HypaV3EmbeddingResult<Metadata>;

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

function wrapWithXml(tag: string, content: string): string {
  return `<${tag}>\n${content}\n</${tag}>`;
}

function cleanOrphanedSummary(chats: HypaV3Message[], data: HypaV3Data): void {
  const removedCount = cleanOrphanedSummaries(
    chats.map((chat) => chat.memo),
    data,
  );
  if (removedCount > 0) {
    console.log(logPrefix, `Cleaned ${removedCount} orphaned summaries.`);
  }
}

const toHypaV3Data = deserializeHypaV3Data;
const toSerializableHypaV3Data = serializeHypaV3Data;
const simpleCC = combineScoredLists;

export async function runHypaV3Experimental(
  input: HypaV3EngineInput,
  runtime: HypaV3Runtime,
): Promise<HypaV3EngineResult> {
  const {
    chats,
    maxContextTokens,
    tokenizer,
    memory: serializedMemory,
    conversationId,
    characterId,
    settings,
  } = input;
  let { currentTokens } = input;
  const room = { id: conversationId, hypaV3Data: serializedMemory };
  const char = { chaId: characterId };

  // Validate settings
  if (settings.recentMemoryRatio + settings.similarMemoryRatio > 1) {
    return {
      currentTokens,
      chats,
      error: `${logPrefix} The sum of Recent Memory Ratio and Similar Memory Ratio is greater than 1.`,
    };
  }

  // Initial token correction
  currentTokens -= input.maxResponseTokens;

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
    const lastSummary = data.summaries.at(-1)!;
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
  const toSummarizeArray: HypaV3Message[][] = [];

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

    const toSummarize: HypaV3Message[] = [];
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
    const rateLimiter = runtime.createRateLimiter({
      tasksPerMinute: settings.summarizationRequestsPerMinute,
      maxConcurrentTasks: settings.summarizationMaxConcurrent,
    });

    rateLimiter.taskQueueChangeCallback = (queuedCount) => {
      runtime.onProgress({
        open: true,
        miniMsg: `${rateLimiter.queuedTaskCount}`,
        msg: `${logPrefix} Summarizing...`,
        subMsg: `${rateLimiter.queuedTaskCount} queued`,
      });
    };

    const summarizationTasks = toSummarizeArray.map(
      (item) => () => runtime.summarize(item, false),
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

    runtime.onProgress({
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
    const newChats: HypaV3Message[] = chats.slice(startIdx);

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
    const processor = runtime.createEmbeddingProcessor<Summary>({
      serverIndexId: `hypav3-exp:${char.chaId}:${room.id}`,
      rateLimiter: runtime.createRateLimiter({
        tasksPerMinute: settings.embeddingRequestsPerMinute,
        maxConcurrentTasks: settings.embeddingMaxConcurrent,
      }),
    });

    processor.progressCallback = (queuedCount) => {
      runtime.onProgress({
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
      runtime.onProgress({
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
          const summary = rankedSummaries.shift()!;
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
        runtime.onProgress({
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
      .sort(() => runtime.random() - 0.5); // Random shuffle

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

  const newChats: HypaV3Message[] = [
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
