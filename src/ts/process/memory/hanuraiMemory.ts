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
  console.log(chats.length, maxRecentChatQuery, queryStartIndex);
  for (
    let index = 0;
    index <= queryStartIndex && index < chats.length;
    index++
  ) {
    const chat = chats[index];
    if (!chat?.content?.trim()) {
      continue;
    }
    if (db.hanuraiSplit) {
      const splited = chat.content.split("\n\n");
      for (const split of splited) {
        const trimmed = split.trim();
        if (!trimmed) {
          continue;
        }
        addTexts.push(`search_document: ${trimmed}`);
      }
    } else {
      addTexts.push(`search_document: ${chat.content.trim()}`);
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
    const searchResults = await processer.similaritySearchScored(
      "search_query: " + chat.content,
    );
    for (const [key, score] of searchResults) {
      const discounted = score / i;
      if (scoredResults[key]) {
        scoredResults[key] += discounted;
      } else {
        scoredResults[key] = discounted;
      }
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
  for (const chat of chats) {
    if (chat.content) existingContents.add(chat.content);
  }
  const candidateTexts: string[] = [];
  const candidateChats: OpenAIChat[] = [];
  for (const [vectorKey] of vectorResult) {
    const content = vectorKey.substring(16);
    if (!existingContents.has(content)) {
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
