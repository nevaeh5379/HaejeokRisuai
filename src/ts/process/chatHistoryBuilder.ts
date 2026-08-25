import type { character, Chat, groupChat, Message } from "../storage/database.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { ChatTokenizer } from "../tokenizer";
import { getUserName } from "../util";
import { getModelInfo, LLMFlags } from "../model/modellist";
import { readImage } from "../globalApi.svelte";
import { v4 } from "uuid";
import { exampleMessage } from "./exampleMessages";
import { processScript, processScriptFull, risuChatParser } from "./scripts";
import { runTrigger } from "./triggers";
import { setCurrentChat } from "../storage/database.svelte";
import { getInlayAsset } from "./files/inlays";
import { runImageEmbedding } from "./transformers";
import { getModuleAssets } from "./modules";
import type { MultiModal, OpenAIChat } from "./index.svelte";

type LorePrompt = Awaited<
  ReturnType<typeof import("./lorebook.svelte").loadLoreBookV3Prompt>
>;
type DepthPrompt = LorePrompt["actives"][number];

function getActiveMessages(chat: Chat) {
  const messages: Message[] = [];
  let reset = false;
  for (let i = chat.message.length - 1; i >= 0; i--) {
    const message = chat.message[i];
    if (message.disabled === true) continue;
    if (message.disabled === "allBefore") {
      reset = true;
      break;
    }
    messages.unshift(message);
  }
  return { messages, reset };
}

async function addFirstMessage(
  chats: OpenAIChat[],
  currentChar: character,
  nowChatroom: character | groupChat,
  currentChat: Chat,
  usingPromptTemplate: boolean,
) {
  const active = getActiveMessages(currentChat);
  if (nowChatroom.type === "group" || active.reset) return null;

  const firstMessage =
    currentChat.fmIndex === -1
      ? nowChatroom.firstMessage
      : nowChatroom.alternateGreetings[currentChat.fmIndex];
  const chat: OpenAIChat = {
    role: "assistant",
    content: await processScript(
      nowChatroom,
      risuChatParser(firstMessage, { chara: currentChar }),
      "editprocess",
    ),
  };
  if (usingPromptTemplate && settingsStore.state.promptSettings.sendName) {
    chat.content = `${currentChar.name}: ${chat.content}`;
    chat.attr = ["nameAdded"];
  }
  chats.push(chat);
  return chat;
}

function extractInlayReferences(content: string, role: Message["role"]) {
  const inlays: string[] = [];
  if (role === "char") {
    content = content.replace(
      /{{(inlay|inlayed|inlayeddata)::(.+?)}}/g,
      (_match: string, kind: string, value: string) => {
        if (value && kind === "inlayeddata") inlays.push(value);
        return "";
      },
    );
  } else {
    inlays.push(...(content.match(/{{(inlay|inlayed|inlayeddata)::(.+?)}}/g) ?? []));
  }
  return { content, inlays };
}

async function resolveInlays(content: string, inlays: string[]) {
  const multimodals: MultiModal[] = [];
  const modelInfo = getModelInfo(settingsStore.state.aiModel);
  for (const inlay of inlays) {
    const name = inlay
      .replace("{{inlayed::", "")
      .replace("{{inlay::", "")
      .replace("}}", "")
      .replace("{{inlayeddata::", "");
    const data = await getInlayAsset(name);
    if (data?.type === "image") {
      if (modelInfo.flags.includes(LLMFlags.hasImageInput)) {
        multimodals.push({
          type: "image",
          base64: data.data,
          width: data.width,
          height: data.height,
        });
      } else {
        const caption = await runImageEmbedding(data.data);
        content += `[${caption[0].generated_text}]`;
      }
    } else if ((data?.type === "video" || data?.type === "audio") && multimodals.length === 0) {
      multimodals.push({ type: data.type, base64: data.data });
    } else if (data?.type === "signature") {
      multimodals.push({ type: "signature", base64: data.data });
    }
    content = content.replace(inlay, "");
  }
  return { content, multimodals };
}

async function resolveAssetPrompts(
  content: string,
  multimodals: MultiModal[],
  currentChar: character,
) {
  const assetPromises: Promise<void>[] = [];
  const moduleAssets = getModuleAssets();
  const assets = (currentChar.additionalAssets ?? []).concat(moduleAssets);
  content = content.replace(/\{\{asset_?prompt::(.+?)\}\}/gimsu, (_match, name) => {
    const asset = assets.find((entry) => entry[0] === name);
    const imagePath = asset?.[1] ?? (name === "icon" ? currentChar.image ?? "" : null);
    if (imagePath !== null) {
      assetPromises.push(
        (async () => {
          const data = await readImage(imagePath);
          multimodals.push({
            type: "image",
            base64: `data:image/png;base64,${Buffer.from(data).toString("base64")}`,
          });
        })(),
      );
    }
    return "";
  });
  await Promise.all(assetPromises);
  return content;
}

function resolveMessageRole(
  message: Message,
  currentChar: character,
  nowChatroom: character | groupChat,
  usingPromptTemplate: boolean,
  findCharacter: (id: string) => character,
  content: string,
) {
  let role: "user" | "assistant" | "system" =
    message.role === "user" ? "user" : "assistant";
  const shouldWrapName =
    (nowChatroom.type === "group" &&
      findCharacter(message.saying).chaId !== currentChar.chaId) ||
    (nowChatroom.type === "group" && settingsStore.state.groupOtherBotRole === "assistant") ||
    (usingPromptTemplate && settingsStore.state.promptSettings.sendName);

  if (!shouldWrapName) return { role, content };

  const format =
    settingsStore.state.groupTemplate ||
    `<{{char}}\'s Message>\n{{slot}}\n</{{char}}\'s Message>`;
  content = risuChatParser(format, {
    chara: findCharacter(message.saying).name,
  }).replace("{{slot}}", content);
  role = ["user", "assistant", "system"].includes(
    settingsStore.state.groupOtherBotRole,
  )
    ? (settingsStore.state.groupOtherBotRole as typeof role)
    : "assistant";
  return { role, content };
}

function extractThoughts(content: string, index: number, messageCount: number) {
  const thoughts: string[] = [];
  const maxDepth = settingsStore.state.promptSettings?.maxThoughtTagDepth ?? -1;
  content = content.replace(/<Thoughts>(.+)<\/Thoughts>/gms, (_match, thought) => {
    if (maxDepth === -1 || maxDepth - messageCount <= index) thoughts.push(thought);
    return "";
  });
  return { content, thoughts };
}

async function formatHistoryMessage(
  message: Message,
  index: number,
  messageCount: number,
  currentChar: character,
  nowChatroom: character | groupChat,
  usingPromptTemplate: boolean,
  findCharacter: (id: string) => character,
): Promise<OpenAIChat> {
  let content = (
    await processScriptFull(
      nowChatroom,
      risuChatParser(message.data, { chara: currentChar, role: message.role }),
      "editprocess",
      index,
      { chatRole: message.role },
    )
  ).data;
  message.chatId ??= v4();

  const extracted = extractInlayReferences(content, message.role);
  const resolved = await resolveInlays(extracted.content, extracted.inlays);
  content = await resolveAssetPrompts(resolved.content, resolved.multimodals, currentChar);
  const roleResult = resolveMessageRole(
    message,
    currentChar,
    nowChatroom,
    usingPromptTemplate,
    findCharacter,
    content,
  );
  const thoughtResult = extractThoughts(roleResult.content, index, messageCount);
  const chat: OpenAIChat = {
    role: roleResult.role,
    content: thoughtResult.content,
    memo: message.chatId,
    attr: [],
    multimodals: resolved.multimodals,
    thoughts: thoughtResult.thoughts,
  };
  if (chat.multimodals?.length === 0) delete chat.multimodals;
  return chat;
}

export interface BuildChatHistoryOptions {
  currentChar: character;
  nowChatroom: character | groupChat;
  currentChat: Chat;
  usingPromptTemplate: boolean;
  tokenizer: ChatTokenizer;
  currentTokens: number;
  lorePrompt: LorePrompt;
  resolvePosition: (text: string, maxDepth?: number) => string;
  findCharacter: (id: string) => character;
}

export async function buildChatHistory(options: BuildChatHistoryOptions) {
  let { currentChat, currentTokens } = options;
  const chats = exampleMessage(options.currentChar, getUserName());
  currentTokens += await options.tokenizer.tokenizeChats(chats);

  if (
    !settingsStore.state.aiModel.startsWith("novelai") &&
    !settingsStore.state.promptSettings?.trimStartNewChat
  ) {
    chats.push({ role: "system", content: "[Start a new chat]", memo: "NewChat" });
  }

  const firstMessage = await addFirstMessage(
    chats,
    options.currentChar,
    options.nowChatroom,
    currentChat,
    options.usingPromptTemplate,
  );
  if (firstMessage) currentTokens += await options.tokenizer.tokenizeChat(firstMessage);

  let active = getActiveMessages(currentChat);
  const triggerResult = await runTrigger(options.currentChar, "start", { chat: currentChat });
  if (triggerResult) {
    currentChat = triggerResult.chat;
    setCurrentChat(currentChat);
    active = getActiveMessages(currentChat);
    currentTokens += triggerResult.tokens;
    if (triggerResult.stopSending) {
      return { stopSending: true as const, currentChat, currentTokens };
    }
  }

  const historyStart = chats.length;
  for (let index = 0; index < active.messages.length; index++) {
    chats.push(
      await formatHistoryMessage(
        active.messages[index],
        index,
        active.messages.length,
        options.currentChar,
        options.nowChatroom,
        options.usingPromptTemplate,
        options.findCharacter,
      ),
    );
  }
  currentTokens += await options.tokenizer.tokenizeChats(chats.slice(historyStart));

  const depthPrompts = options.lorePrompt.actives.filter(
    (prompt) => (prompt.pos === "depth" && prompt.depth > 0) || prompt.pos === "reverse_depth",
  );
  for (const depthPrompt of depthPrompts) {
    currentTokens += await options.tokenizer.tokenizeChat({
      role: depthPrompt.role,
      content: risuChatParser(options.resolvePosition(depthPrompt.prompt), {
        chara: options.currentChar,
      }),
    });
  }

  return {
    stopSending: false as const,
    chats,
    currentChat,
    currentTokens,
    triggerResult,
    depthPrompts: depthPrompts as DepthPrompt[],
  };
}
