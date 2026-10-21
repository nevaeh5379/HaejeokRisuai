import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { alertError } from "src/ts/alert";
import type { OpenAIChat } from "@risuai/chat-core/types.ts";
import { HypaProcesser } from "./hypamemory";
import { language } from "src/lang";
import type { ChatTokenizer } from "src/ts/tokenizer";

const maxRecentChatQuery = 4;
export async function hanuraiMemory(
  chats: OpenAIChat[],
  arg: {
    currentTokens: number;
    maxContextTokens: number;
    tokenizer: ChatTokenizer;
    serverIndexId?: string;
  },
) {
  const db = settingsStore.state;
  const tokenizer = arg.tokenizer;
  const processer = new HypaProcesser(
    "auto",
    undefined,
    arg.serverIndexId ? `hanurai:${arg.serverIndexId}` : undefined,
  );
  let addTexts: string[] = [];
  const queryStartIndex = chats.length - maxRecentChatQuery;
  for (let index = 0; index < chats.length; index++) {
    if (queryStartIndex < index) {
      continue;
    }
    const chat = chats[index];
    const content = chat?.content?.trim();
    if (!content) {
      continue;
    }
    if (db.hanuraiSplit) {
      const splited = content.split("\n\n");
      for (let s = 0; s < splited.length; s++) {
        const trimmedSplit = splited[s].trim();
        if (!trimmedSplit) {
          continue;
        }
        addTexts.push(`search_document: ${trimmedSplit}`);
      }
    } else {
      addTexts.push(`search_document: ${content}`);
    }
  }
  if (!(await processer.prepareServerTextIndex(addTexts))) {
    await processer.addText(addTexts);
  }

  let scoredResults: { [key: string]: number } = {};
  for (let i = 1; i < maxRecentChatQuery; i++) {
    const chat = chats[chats.length - i];
    if (!chat?.content) {
      continue;
    }
    const scoredArray = await processer.similaritySearchScored(
      "search_query: " + chat.content,
    );
    const weight = 1 / i;
    for (let s = 0; s < scoredArray.length; s++) {
      const result = scoredArray[s];
      const key = result[0];
      const weightedScore = result[1] * weight;
      scoredResults[key] = (scoredResults[key] || 0) + weightedScore;
    }
  }
  const vectorResult = Object.entries(scoredResults).sort(
    (a, b) => b[1] - a[1],
  );

  let tokens = arg.currentTokens + db.hanuraiTokens;

  if (tokens > arg.maxContextTokens) {
    const chatTokenCounts = await tokenizer.tokenizeChatsDetailed(chats);
    let removeCount = 0;
    while (tokens > arg.maxContextTokens && removeCount < chats.length) {
      tokens -= chatTokenCounts[removeCount];
      removeCount += 1;
    }
    if (tokens > arg.maxContextTokens) {
      alertError(
        language.errors.toomuchtoken + "\n\nRequired Tokens: " + tokens,
      );
      return false;
    }
    if (removeCount > 0) chats.splice(0, removeCount);
  }

  tokens -= db.hanuraiTokens;

  const existingContents = new Set<string>();
  for (let i = 0; i < chats.length; i++) {
    const content = chats[i]?.content;
    if (content) {
      existingContents.add(content);
    }
  }

  const candidateTexts: string[] = [];
  const candidateChats: OpenAIChat[] = [];
  for (let i = 0; i < vectorResult.length; i++) {
    const rawKey = vectorResult[i][0];
    const content = rawKey.length > 16 ? rawKey.substring(16) : "";
    if (content && !existingContents.has(content)) {
      candidateTexts.push(content);
      candidateChats.push({
        role: "system" as const,
        memo: "supaMemory",
        content,
      });
    }
  }
  const candidateTokenCounts =
    await tokenizer.tokenizeChatsDetailed(candidateChats);
  let resultTexts: string[] = [];
  for (let i = 0; i < candidateTexts.length; i++) {
    const tokenized = candidateTokenCounts[i] + 2;
    tokens += tokenized;
    if (tokens >= arg.maxContextTokens) {
      tokens -= tokenized;
      break;
    }
    resultTexts.push(candidateTexts[i]);
  }
  chats.unshift({
    role: "system",
    memo: "supaMemory",
    content: resultTexts.join("\n\n"),
  });
  return {
    tokens,
    chats,
  };
}
