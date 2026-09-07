import {
  childToParentRRF,
  cleanOrphanedSummaries,
  combineScoredLists,
  deserializeHypaV3Data,
  serializeHypaV3Data,
} from "./core.js";
import type {
  HypaV3EngineInput,
  HypaV3EngineResult,
  HypaV3Message,
  HypaV3Runtime,
  HypaV3SummaryChunk,
} from "./engine.js";
import type { HypaV3Data, HypaV3Summary } from "./types.js";

type Summary = HypaV3Summary;
type SummaryChunk = HypaV3SummaryChunk;

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

export async function runHypaV3Legacy(
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

    const toSummarize: HypaV3Message[] = [];
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
        const summarizeResult = await runtime.summarize(toSummarize, false);

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
    const processor = runtime.createLegacyEmbeddingProcessor({
      serverIndexId: `hypav3:${char.chaId}:${room.id}`,
    });

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
          const summarizeResult = await runtime.summarize(recentChats, false);

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
