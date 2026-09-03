import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { alertError } from "src/ts/alert";
import type { OpenAIChat } from "@risuai/chat-core/types.cjs";
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
  chats.map((chat, index) => {
    if (queryStartIndex < index) {
      return;
    }
    if (!chat?.content?.trim()) {
      return;
    }
    if (db.hanuraiSplit) {
      const splited = chat.content.split("\n\n");
      for (const split of splited) {
        if (!split.trim()) {
          continue;
        }
        addTexts.push(`search_document: ${split.trim()}`);
      }
    } else {
      addTexts.push(`search_document: ${chat.content?.trim()}`);
    }
  });
  if (!(await processer.prepareServerTextIndex(addTexts))) {
    await processer.addText(addTexts);
  }

  let scoredResults: { [key: string]: number } = {};
  for (let i = 1; i < maxRecentChatQuery; i++) {
    const chat = chats[chats.length - i];
    if (!chat?.content) {
      continue;
    }
    const scoredArray = (
      await processer.similaritySearchScored("search_query: " + chat.content)
    ).map((result) => {
      return [result[0], result[1] / i] as [string, number];
    });
    for (const scored of scoredArray) {
      if (scoredResults[scored[0]]) {
        scoredResults[scored[0]] += scored[1];
      } else {
        scoredResults[scored[0]] = scored[1];
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

  const existingContents = new Set(chats.map((chat) => chat.content));
  const candidateTexts = vectorResult
    .map((vector) => vector[0].substring(16))
    .filter((content) => !existingContents.has(content));
  const candidateChats = candidateTexts.map((content) => ({
    role: "system" as const,
    memo: "supaMemory",
    content,
  }));
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
