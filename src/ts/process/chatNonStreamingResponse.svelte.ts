import type {
  character,
  groupChat,
  Chat,
  MessageGenerationInfo,
  MessagePresetInfo,
} from "../storage/database.svelte";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { processScriptFull } from "./scripts";
import { addRerolls } from "./prereroll";
import { runInlayScreen } from "./inlayScreen";
import { sayTTS } from "./tts";
import { trimUntilPunctuation } from "../util";
import {
  applyOutputTrigger,
  findMessageIndexByChatId,
  runChatOutputListeners,
} from "./chatResponseShared.svelte";

type NonStreamingRequest = Exclude<
  Awaited<ReturnType<typeof import("./request/request").requestChatData>>,
  { type: "streaming" } | { type: "fail" }
>;

interface NonStreamingOptions {
  req: NonStreamingRequest;
  selectedChar: number;
  selectedChat: number;
  currentChar: character;
  nowChatroom: character | groupChat;
  currentChat: Chat;
  continueGeneration?: boolean;
  generationInfo: MessageGenerationInfo;
  promptInfo: MessagePresetInfo;
  generationId: string;
  reformatContent: (data: string) => string;
}

export async function processNonStreamingResponse(options: NonStreamingOptions) {
  const responses =
    options.req.type === "success"
      ? ([["char", options.req.result]] as const)
      : options.req.type === "multiline"
        ? options.req.result
        : [];
  const rerolls: string[] = [];
  let result = "";
  let emoChanged = false;
  let outputMessageId: string | undefined;

  for (let i = 0; i < responses.length; i++) {
    const response = responses[i];
    const content = response[1];
    const messages =
      characterStore.characters[options.selectedChar].chats[
        options.selectedChat
      ].message;
    let msgIndex = messages.length;
    let processed = await processScriptFull(
      options.nowChatroom,
      options.reformatContent(content),
      "editoutput",
      msgIndex,
    );

    if (i === 0 && options.continueGeneration) {
      msgIndex -= 1;
      processed = await processScriptFull(
        options.nowChatroom,
        options.reformatContent(messages[msgIndex].data + content),
        "editoutput",
        msgIndex,
      );
    }
    if (settingsStore.state.removeIncompleteResponse) {
      processed.data = trimUntilPunctuation(processed.data);
    }

    result = processed.data;
    const inlay = runInlayScreen(options.currentChar, result);
    result = inlay.text;
    emoChanged = processed.emoChanged;

    if (i === 0 && options.continueGeneration) {
      messages[msgIndex] = {
        role: "char",
        data: result,
        saying: options.currentChar.chaId,
        time: Date.now(),
        generationInfo: options.generationInfo,
        promptInfo: options.promptInfo,
        chatId: options.generationId,
      };
      if (inlay.promise) messages[msgIndex].data = await inlay.promise;
      outputMessageId = messages[msgIndex]?.chatId;
    } else if (i === 0) {
      messages.push({
        role: response[0],
        data: result,
        saying: options.currentChar.chaId,
        time: Date.now(),
        generationInfo: options.generationInfo,
        promptInfo: options.promptInfo,
        chatId: options.generationId,
      });
      const index = messages.length - 1;
      if (inlay.promise) messages[index].data = await inlay.promise;
      rerolls.push(result);
      outputMessageId = messages[index]?.chatId;
    } else {
      rerolls.push(result);
    }

    characterStore.characters[options.selectedChar].reloadKeys += 1;
    if (settingsStore.state.ttsAutoSpeech) {
      await sayTTS(options.currentChar, result);
    }
  }

  if (rerolls.length > 1) addRerolls(options.generationId, rerolls);
  const triggered = await applyOutputTrigger(
    options.currentChar,
    options.selectedChar,
    options.selectedChat,
  );
  const currentChat = triggered.currentChat;
  if (outputMessageId) {
    await runChatOutputListeners(
      options.currentChar,
      currentChat,
      options.selectedChar,
      options.selectedChat,
      findMessageIndexByChatId(currentChat, outputMessageId),
    );
  }

  return {
    ok: true as const,
    result,
    emoChanged,
    resendChat: triggered.resendChat,
    currentChat,
  };
}
