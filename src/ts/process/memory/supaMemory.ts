import type { OpenAIChat } from "@risuai/chat-core/types.cjs";
import {
  getDatabase,
  type Chat,
  type character,
  type groupChat,
} from "../../storage/database.svelte";
import { tokenize, type ChatTokenizer } from "../../tokenizer";
import { requestChatData } from "../request/chatRequestOrchestrator";
import { HypaProcesser } from "./hypamemory";
import { stringlizeChat } from "../stringlize";
import { globalFetch } from "src/ts/globalApi.svelte";
import { runSummarizer } from "../transformers";
import { parseChatML } from "src/ts/parser/chatML";
import { getUserName } from "src/ts/util";

export async function supaMemory(
  chats: OpenAIChat[],
  currentTokens: number,
  maxContextTokens: number,
  room: Chat,
  char: character | groupChat,
  tokenizer: ChatTokenizer,
  arg: { asHyper?: boolean } = {},
): Promise<{
  currentTokens: number;
  chats: OpenAIChat[];
  error?: string;
  memory?: string;
  lastId?: string;
}> {
  const db = getDatabase();

  currentTokens += 10;

  if (currentTokens > maxContextTokens) {
    // SupaMemory repeatedly trims and probes the same prompt history. Compute
    // per-message token costs once so Node deployments can batch the work and
    // every later prefix operation becomes simple arithmetic.
    let chatTokenCounts = await tokenizer.tokenizeChatsDetailed(chats);
    const tokenPrefixSum = (count: number) =>
      chatTokenCounts
        .slice(0, Math.max(0, count))
        .reduce((total, tokens) => total + tokens, 0);
    const discardPrefix = (count: number) => {
      if (count <= 0) return;
      currentTokens -= tokenPrefixSum(count);
      chats.splice(0, count);
      chatTokenCounts.splice(0, count);
    };

    let coIndex = -1;
    for (let i = 0; i < chats.length; i++) {
      if (chats[i].memo === "NewChat") {
        coIndex = i;
        break;
      }
    }
    if (coIndex !== -1) {
      discardPrefix(coIndex);
    }

    let supaMemory = "";
    let hypaChunks: string[] = [];
    let lastId = "";
    let HypaData: HypaData[] = [];

    if (room.supaMemoryData && room.supaMemoryData.length > 4) {
      const splited = room.supaMemoryData.split("\n");
      let id = splited.splice(0, 1)[0];
      const data = splited.join("\n");

      if (arg.asHyper && !id.startsWith("hypa:")) {
        supaMemory = "";
      } else {
        if (id.startsWith("hypa:")) {
          if (!arg.asHyper) {
            return {
              currentTokens: currentTokens,
              chats: chats,
              error:
                "SupaMemory: Data saved in hypaMemory, loaded as SupaMemory.",
            };
          }
          HypaData = JSON.parse(data.trim());
          if (!Array.isArray(HypaData)) {
            return {
              currentTokens: currentTokens,
              chats: chats,
              error: "hypaMemory: hypaMemory isn't Array",
            };
          }

          let indexSelected = -1;
          for (let j = 0; j < HypaData.length; j++) {
            const chatIndex = chats.findIndex(
              (chat) => chat.memo === HypaData[j].id,
            );
            if (chatIndex === -1) continue;
            lastId = HypaData[j].id;
            discardPrefix(chatIndex);
            indexSelected = j;
            break;
          }
          if (indexSelected === -1) {
            return {
              currentTokens: currentTokens,
              chats: chats,
              error: "hypaMemory: chat ID not found",
            };
          }

          supaMemory = HypaData[indexSelected].supa;
          hypaChunks = HypaData[indexSelected].hypa;
        } else {
          const chatIndex = chats.findIndex((chat) => chat.memo === id);
          if (chatIndex === -1) {
            return {
              currentTokens: currentTokens,
              chats: chats,
              error: "SupaMemory: chat ID not found",
            };
          }
          discardPrefix(chatIndex);
          lastId = id;

          supaMemory = data;
          if (db.removePunctuationHypa) {
            supaMemory = supaMemory.replace(
              /[\.,\/#!$%\^&\*;:{}=\-_`~()]/g,
              "",
            );
          }
          currentTokens += await tokenize(supaMemory);
        }
      }
    }

    let hypaResult = "";

    if (arg.asHyper) {
      const hypa = new HypaProcesser(
        db.hypaModel,
        undefined,
        room.id ? `supa-hypa:${char.chaId}:${room.id}` : undefined,
      );
      hypa.oaikey = db.supaMemoryKey;
      hypaChunks = hypaChunks.filter((value) => value.length > 1);
      if (hypaChunks.length > 0) {
        const retrievalTexts = hypaChunks
          .filter((value, index, self) => self.indexOf(value) === index)
          .map((value) => {
            if (db.removePunctuationHypa) {
              return value.replace(/[\.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
            }
            return value;
          })
          .filter((value) => {
            return !supaMemory
              .replace(/[\.,\/#!$%\^&\*;:{}=\-_`~()]/g, "")
              .includes(value.replace(/[\.,\/#!$%\^&\*;:{}=\-_`~()]/g, ""));
          });
        if (!(await hypa.prepareServerTextIndex(retrievalTexts))) {
          await hypa.addText(retrievalTexts);
        }
        const filteredChat = chats.filter(
          (r) => r.role !== "system" && r.role !== "function",
        );
        const s = await hypa.similaritySearch(
          stringlizeChat(filteredChat.slice(0, 4), char?.name ?? "", false),
          3,
        );
        hypaResult = "";
        if (s.length > 0) {
          hypaResult = "past events: " + s.slice(0, 3);
          currentTokens += await tokenizer.tokenizeChat({
            role: "assistant",
            content: hypaResult,
            memo: "hypaMemory",
          });
          currentTokens += 10;
        }
      }
    }

    if (currentTokens < maxContextTokens) {
      chats.unshift({
        role: "system",
        content: supaMemory + "\n\n" + hypaResult,
        memo: "supaMemory",
      });
      return {
        currentTokens: currentTokens,
        chats: chats,
      };
    }

    async function summarize(stringlizedChat: string) {
      if (db.supaModelType === "distilbart") {
        try {
          const sum = await runSummarizer(stringlizedChat);
          return sum;
        } catch (error) {
          return {
            currentTokens: currentTokens,
            chats: chats,
            error: "SupaMemory: Summarizer: " + `${error}`,
          };
        }
      }

      const supaPrompt =
        db.supaMemoryPrompt === ""
          ? "[Summarize the ongoing role story, It must also remove redundancy and unnecessary text and content from the output to reduce tokens for gpt3 and other sublanguage models]\n"
          : db.supaMemoryPrompt;

      let result = "";

      if (db.supaModelType !== "subModel") {
        const promptbody =
          stringlizedChat + "\n\n" + supaPrompt + "\n\nOutput:";

        const da = await globalFetch("https://api.openai.com/v1/completions", {
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + db.supaMemoryKey,
          },
          method: "POST",
          body: {
            model:
              db.supaModelType === "curie"
                ? "text-curie-001"
                : db.supaModelType === "instruct35"
                  ? "gpt-3.5-turbo-instruct"
                  : "text-davinci-003",
            prompt: promptbody,
            max_tokens: 600,
            temperature: 0,
          },
        });

        try {
          if (!da.ok) {
            return {
              currentTokens: currentTokens,
              chats: chats,
              error: "SupaMemory: HTTP: " + JSON.stringify(da.data),
            };
          }

          result = (await da.data)?.choices[0]?.text?.trim();

          if (!result) {
            return {
              currentTokens: currentTokens,
              chats: chats,
              error: "SupaMemory: HTTP: " + JSON.stringify(da.data),
            };
          }

          return result;
        } catch (error) {
          return {
            currentTokens: currentTokens,
            chats: chats,
            error: "SupaMemory: HTTP: " + error,
          };
        }
      } else {
        let parsedPrompt = parseChatML(
          supaPrompt.replaceAll("{{slot}}", stringlizedChat),
        );
        const promptbody: OpenAIChat[] = parsedPrompt ?? [
          {
            role: "user",
            content: stringlizedChat,
          },
          {
            role: "system",
            content: supaPrompt,
          },
        ];
        const da = await requestChatData(
          {
            formated: promptbody,
            bias: {},
            useStreaming: false,
            noMultiGen: true,
          },
          "memory",
        );
        if (
          da.type === "fail" ||
          da.type === "streaming" ||
          da.type === "multiline"
        ) {
          return {
            currentTokens: currentTokens,
            chats: chats,
            error: "SupaMemory: HTTP: " + da.result,
          };
        }
        result = da.result;
      }
      return result;
    }

    while (currentTokens > maxContextTokens) {
      const beforeToken = currentTokens;
      let maxChunkSize = Math.floor(maxContextTokens / 3);
      if (db.maxSupaChunkSize < maxChunkSize) {
        maxChunkSize = db.maxSupaChunkSize;
      }
      let summarized = false;
      let chunkSize = 0;
      let stringlizedChat = "";
      let spiceLen = 0;
      while (true) {
        const cont = chats[spiceLen];
        if (!cont) {
          currentTokens = beforeToken;
          stringlizedChat = "";
          chunkSize = 0;
          spiceLen = 0;
          if (summarized) {
            if (maxChunkSize < 500) {
              return {
                currentTokens: currentTokens,
                chats: chats,
                error: "Not Enough Tokens to summarize in SupaMemory",
              };
            }
            maxChunkSize = maxChunkSize * 0.7;
          } else {
            const result = await summarize(supaMemory);
            if (typeof result !== "string") {
              return result;
            }

            currentTokens -= await tokenize(supaMemory);
            currentTokens += await tokenize(result + "\n\n");

            supaMemory = result + "\n\n";
            summarized = true;
            if (currentTokens <= maxContextTokens) {
              break;
            }
          }
          continue;
        }
        const tokens = chatTokenCounts[spiceLen];
        if (chunkSize + tokens > maxChunkSize) {
          if (stringlizedChat === "") {
            if (cont.role !== "function" && cont.role !== "system") {
              stringlizedChat += `${cont.role === "assistant" ? (char.type === "group" ? "" : char.name) : getUserName()}: ${cont.content}\n\n`;
              spiceLen += 1;
              currentTokens -= tokens;
              chunkSize += tokens;
            }
          }
          lastId = cont.memo;
          break;
        }
        stringlizedChat += `${cont.role === "assistant" ? (char.type === "group" ? "" : char.name) : getUserName()}: ${cont.content}\n\n`;
        spiceLen += 1;
        currentTokens -= tokens;
        chunkSize += tokens;
      }
      chats.splice(0, spiceLen);
      chatTokenCounts.splice(0, spiceLen);

      if (stringlizedChat !== "") {
        const result = await summarize(stringlizedChat);

        if (typeof result !== "string") {
          return result;
        }

        const tokenz = await tokenize(result + "\n\n");
        hypaChunks.push(result.replace(/\n+/g, "\n"));

        let SupaMemoryList = supaMemory
          .split("\n\n")
          .filter((value) => value.length > 1);
        if (SupaMemoryList.length >= (arg.asHyper ? 3 : 4)) {
          const oldSupaMemory = supaMemory;
          const result = await summarize(supaMemory);
          if (typeof result !== "string") {
            return result;
          }
          supaMemory = result;
          currentTokens -= await tokenize(oldSupaMemory);
          currentTokens += await tokenize(supaMemory);
        }
        SupaMemoryList = supaMemory
          .split("\n\n")
          .filter((value) => value.length > 1);
        SupaMemoryList.push(result.replace(/\n+/g, "\n"));
        currentTokens += tokenz;
        supaMemory = SupaMemoryList.join("\n\n");
      }
    }

    chats.unshift({
      role: "system",
      content: supaMemory,
      memo: "supaMemory",
    });

    if (arg.asHyper) {
      if (hypaResult !== "") {
        chats.unshift({
          role: "system",
          content: hypaResult,
          memo: "hypaMemory",
        });
      }

      if (HypaData[0] && HypaData[0].id === lastId) {
        HypaData[0].hypa = hypaChunks;
        HypaData[0].supa = supaMemory;
      } else {
        HypaData.unshift({
          id: lastId,
          hypa: hypaChunks,
          supa: supaMemory,
        });
      }

      return {
        currentTokens: currentTokens,
        chats: chats,
        memory: "hypa:\n" + JSON.stringify(HypaData, null, 2),
        lastId: lastId,
      };
    }

    return {
      currentTokens: currentTokens,
      chats: chats,
      memory: lastId + "\n" + supaMemory,
      lastId: lastId,
    };
  }
  return {
    currentTokens: currentTokens,
    chats: chats,
  };
}

type HypaData = { id: string; supa: string; hypa: string[] };
