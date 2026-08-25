import { get } from "svelte/store";
import type { character } from "../storage/database.svelte";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { CharEmotion } from "../stores.svelte";
import { tokenizeNum } from "../tokenizer";
import { language } from "../../lang";
import { requestChatData } from "./request/chatRequestOrchestrator";
import { HypaProcesser } from "./memory/hypamemory";
import { stableDiff } from "./stableDiff";
import type { ChatModelResponse, OpenAIChat } from "@risuai/chat-core/types.cjs";

type EmotionAsset = [string, string];
type EmotionHistoryEntry = [string, string, number];
type EmotionMap = Record<string, EmotionHistoryEntry[]>;

interface EmotionState {
  map: EmotionMap;
  history: EmotionHistoryEntry[];
  assets: EmotionAsset[];
}

function getEmotionState(currentChar: character): EmotionState {
  const map = get(CharEmotion) as EmotionMap;
  const history = map[currentChar.chaId] ?? [];
  if (history.length > 4) {
    history.splice(0, 1);
  }
  return { map, history, assets: currentChar.emotionImages };
}

function commitEmotion(
  currentChar: character,
  state: EmotionState,
  emotion: EmotionAsset,
) {
  state.history.push([emotion[0], emotion[1], Date.now()]);
  state.map[currentChar.chaId] = state.history;
  CharEmotion.set(state.map);
}

function commitNamedEmotion(
  currentChar: character,
  state: EmotionState,
  name: string,
) {
  const emotion = state.assets.find((asset) => asset[0] === name);
  if (!emotion) return false;
  commitEmotion(currentChar, state, emotion);
  return true;
}

function commitEmotionFromText(
  currentChar: character,
  state: EmotionState,
  value: string,
) {
  const normalized = value.replace(/ |\n/g, "").trim().toLocaleLowerCase();
  if (commitNamedEmotion(currentChar, state, normalized)) return true;

  const partial = state.assets.find((asset) => normalized.includes(asset[0]));
  if (partial) {
    commitEmotion(currentChar, state, partial);
    return true;
  }

  return commitNamedEmotion(currentChar, state, "neutral");
}

function shuffleArray<T>(array: T[]) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

async function buildEmotionBias(
  emotionList: string[],
  history: EmotionHistoryEntry[],
) {
  const bias: Record<number, number> = {};
  for (const emotion of emotionList) {
    for (const token of await tokenizeNum(emotion)) {
      bias[token] = 10;
    }
  }

  for (let i = 0; i < history.length; i++) {
    const modifier = 20 - (history.length - (i + 1)) * 5;
    for (const token of await tokenizeNum(history[i][0])) {
      bias[token] -= modifier;
      if (bias[token] < -100) bias[token] = -100;
    }
  }
  return bias;
}

async function processEmbeddingEmotion(
  currentChar: character,
  state: EmotionState,
  result: string,
) {
  const emotionList = state.assets.map((asset) => asset[0]);
  const processor = new HypaProcesser();
  await processor.addText(emotionList.map((emotion) => `emotion:${emotion}`));
  const searched = (await processor.similaritySearchScored(result)).map((entry) => {
    entry[0] = entry[0].replace("emotion:", "");
    return entry;
  });

  for (let i = 0; i < state.history.length; i++) {
    const index = searched.findIndex((entry) => entry[0] === state.history[i][0]);
    if (index !== -1) {
      searched[index][1] -= (5 - (state.history.length - (i + 1))) / 200;
    }
  }

  const best = searched.sort((a, b) => b[1] - a[1])[0]?.[0];
  if (best) commitNamedEmotion(currentChar, state, best);
}

function buildModelEmotionPrompt(emotionList: string[], result: string): OpenAIChat[] {
  const instruction =
    settingsStore.state.emotionPrompt2 ||
    "From the list below, choose a word that best represents a character's outfit description, action, or emotion in their dialogue. Prioritize selecting words related to outfit first, then action, and lastly emotion. Print out the chosen word.";
  return [
    {
      role: "system",
      content: `${instruction}\n\n list: ${shuffleArray([...emotionList]).join(", ")} \noutput only one word.`,
    },
    { role: "user", content: `"Good morning, Master! Is there anything I can do for you today?"` },
    { role: "assistant", content: "happy" },
    { role: "user", content: result },
  ];
}

function handleModelEmotionResponse(
  response: ChatModelResponse,
  currentChar: character,
  state: EmotionState,
  abortSignal: AbortSignal,
  throwError: (error: string) => void,
) {
  if (response.type === "fail") {
    if (!abortSignal.aborted) throwError(response.result);
    return;
  }
  if (response.type === "streaming" || response.type === "multiline") {
    if (!abortSignal.aborted) throwError("Unexpected response type");
    return;
  }
  try {
    commitEmotionFromText(currentChar, state, response.result);
  } catch (error) {
    throwError(language.errors.httpError + `${error}`);
  }
}

async function processModelEmotion(
  currentChar: character,
  state: EmotionState,
  result: string,
  abortSignal: AbortSignal,
  throwError: (error: string) => void,
) {
  const emotionList = state.assets.map((asset) => asset[0]);
  const response = await requestChatData(
    {
      formated: buildModelEmotionPrompt(emotionList, result),
      bias: await buildEmotionBias(emotionList, state.history),
      currentChar,
      maxTokens: 30,
    },
    "emotion",
    abortSignal,
  );
  handleModelEmotionResponse(
    response,
    currentChar,
    state,
    abortSignal,
    throwError,
  );
}

function buildImageGenerationTranscript(selectedChar: number, selectedChat: number) {
  const messages = characterStore.characters[selectedChar].chats[selectedChat].message;
  let transcript = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "char") {
      transcript = `character: ${messages[i].data.replace(/\n/g, " ")} \n${transcript}`;
    } else {
      transcript = `user: ${messages[i].data.replace(/\n/g, " ")} \n${transcript}`;
      break;
    }
  }
  return transcript;
}

export interface PostGenerationEffectsOptions {
  req: ChatModelResponse;
  currentChar: character;
  selectedChar: number;
  selectedChat: number;
  chatProcessIndex: number;
  result: string;
  emoChanged: boolean;
  abortSignal: AbortSignal;
  throwError: (error: string) => void;
}

async function processEmotionEffects(
  options: PostGenerationEffectsOptions,
): Promise<{ returnEarly: boolean; emoChanged: boolean }> {
  let emotionState: EmotionState | undefined;
  const getState = () => (emotionState ??= getEmotionState(options.currentChar));
  let emoChanged = options.emoChanged;

  if (
    options.req.special?.emotion &&
    commitNamedEmotion(options.currentChar, getState(), options.req.special.emotion)
  ) {
    emoChanged = true;
  }
  if (options.currentChar.inlayViewScreen) return { returnEarly: false, emoChanged };
  if (
    options.currentChar.viewScreen !== "emotion" ||
    emoChanged ||
    options.abortSignal.aborted
  ) {
    return { returnEarly: false, emoChanged };
  }

  const state = getState();
  if (settingsStore.state.emotionProcesser === "embedding") {
    await processEmbeddingEmotion(options.currentChar, state, options.result);
  } else {
    await processModelEmotion(
      options.currentChar,
      state,
      options.result,
      options.abortSignal,
      options.throwError,
    );
  }
  return { returnEarly: true, emoChanged };
}

async function processImageGeneration(options: PostGenerationEffectsOptions) {
  if (options.currentChar.viewScreen !== "imggen") return;
  if (options.chatProcessIndex !== -1) {
    options.throwError("Stable diffusion in group chat is not supported");
  }
  await stableDiff(
    options.currentChar,
    buildImageGenerationTranscript(options.selectedChar, options.selectedChat),
  );
}

export async function processPostGenerationEffects(
  options: PostGenerationEffectsOptions,
): Promise<{ returnEarly: boolean; emoChanged: boolean }> {
  const emotion = await processEmotionEffects(options);
  if (emotion.returnEarly) return emotion;
  await processImageGeneration(options);
  return emotion;
}
