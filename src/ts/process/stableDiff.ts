import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { get } from "svelte/store";
import type { character } from "../storage/database/schema";

import type { ChatExecutionTarget } from "src/ts/chatTarget";
import { requestChatData } from "./request/chatRequestOrchestrator";
import { alertError } from "../alert";
import { CharEmotion } from "../stores.svelte";
import type { OpenAIChat } from "@risuai/chat-core/types.cjs";

export async function stableDiff(
  currentChar: character,
  prompt: string,
  chatTarget?: ChatExecutionTarget,
) {
  let db = settingsStore.state;

  if (db.sdProvider === "") {
    alertError("Stable diffusion is not set in settings.");
    return false;
  }

  const promptItem = `Chat:\n${prompt}`;

  const promptbody: OpenAIChat[] = [
    {
      role: "system",
      content: currentChar.newGenData.instructions,
    },
    {
      role: "user",
      content: promptItem,
    },
  ];

  const rq = await requestChatData(
    {
      formated: promptbody,
      currentChar: currentChar,
      triggerTarget: chatTarget,
      temperature: 0.2,
      maxTokens: 300,
      bias: {},
      useStreaming: false,
      noMultiGen: true,
    },
    "submodel",
  );

  if (rq.type === "fail") {
    alertError(rq.result);
    return false;
  }
  if (rq.type === "streaming" || rq.type === "multiline") {
    alertError("Unexpected response type");
    return false;
  }

  const r = rq.result.replace(/<Thoughts>[\s\S]*?<\/Thoughts>/g, "").trim();

  const genPrompt = currentChar.newGenData.prompt.replaceAll("{{slot}}", r);
  const neg = currentChar.newGenData.negative;

  return await generateAIImage(genPrompt, currentChar, neg, "");
}

export async function generateAIImage(
  genPrompt: string,
  currentChar: character,
  neg: string,
  returnSdData: string,
): Promise<string | false> {
  try {
    const { executeImageGeneration } =
      await import("@risuai/protocol/dist/imageGeneration.mjs");
    const { browserImageRuntime, getImageGenerationSettings } =
      await import("./imageGenerationBrowser");
    const image = await executeImageGeneration(
      getImageGenerationSettings(),
      browserImageRuntime,
      genPrompt,
      currentChar,
      neg,
    );
    if (!image) throw new Error("Image generation returned no image");
    if (returnSdData === "inlay") return image;
    const emotions = get(CharEmotion);
    emotions[currentChar.chaId] = [[image, image, Date.now()]];
    CharEmotion.set(emotions);
    return returnSdData;
  } catch (error) {
    alertError(error);
    return false;
  }
}
