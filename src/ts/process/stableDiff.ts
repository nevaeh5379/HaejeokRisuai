import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { get } from "svelte/store";
import type { character } from "../storage/database/schema";

import type { ChatExecutionTarget } from "src/ts/chatTarget";
import { requestChatData } from "./request/chatRequestOrchestrator";
import { alertError } from "../alert";
import { CharEmotion } from "../stores.svelte";
import type { OpenAIChat } from "@risuai/chat-core/types.cjs";

/**
 * Uses the submodel to create tags for the existing character-screen image feature.
 *
 * 한국어: 기존 캐릭터 화면 이미지 기능에서 보조 모델로 태그를 작성한 뒤 그림을 생성하는 함수.
 *
 * @param currentChar - Character whose existing image instructions/prompts are used. / 기존 이미지 지침·프롬프트를 사용할 캐릭터.
 * @param prompt - Dialogue text used to describe the scene. / 장면 설명에 사용할 대화 텍스트.
 * @param chatTarget - Explicit chat target for submodel processing. / 보조 모델 처리용 명시적 채팅 대상.
 * @returns Image operation result, or false on failure. / 이미지 처리 결과 또는 실패 시 false.
 */
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

/**
 * Lazily invokes the shared image core and applies the legacy screen/inlay return behavior.
 *
 * 한국어: 이미지 공통 로직을 지연 호출하고 기존 화면 이미지·인레이 반환 동작을 유지하는 함수.
 *
 * @param genPrompt - Final positive image prompt. / 최종 긍정 그림 프롬프트.
 * @param currentChar - Character used for references and screen image updates. / 참조 이미지·화면 이미지 갱신 대상 캐릭터.
 * @param neg - Negative image prompt. / 네거티브 그림 프롬프트.
 * @param returnSdData - Use "inlay" to return image data; otherwise update CharEmotion and return this value. / "inlay"이면 그림 데이터를 반환, 그 외에는 CharEmotion 갱신 후 전달값을 반환.
 * @returns Image data or the supplied return value, or false after an error alert. / 그림 데이터·전달값 또는 오류 안내 후 false.
 */
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
