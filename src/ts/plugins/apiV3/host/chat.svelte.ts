import { toLegacyLorebook } from "../../legacyObjects";
import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import { selectedCharID } from "src/ts/stores.svelte";
import { characterStore } from "src/ts/stores/domain/characterStore.svelte";
import { messageStore } from "src/ts/stores/domain/messageStore.svelte";
import { v4 } from "uuid";
import { get } from "svelte/store";
import {
  risuChatParser,
  type CbsConditions,
} from "src/ts/parser/parser.svelte";
import { isChatGenerationActive } from "src/ts/process/chat/runtimeState";
import { requireChatTargetFromIndexes } from "src/ts/chatTarget";
import { processScriptFull } from "src/ts/process/scripts";
import { getModelInfo } from "src/ts/model/modellist";
import { getModuleLorebooks } from "src/ts/process/modules";

export const pluginChat = {
  parseRisuChat: async (
    text: string,
    options?: {
      messageIndex?: number;
      role?: string;
      processRegex?: boolean;
      runVar?: boolean;
      rmVar?: boolean;
      tokenizeAccurate?: boolean;
      cbsConditions?: CbsConditions;
    },
  ) => {
    const char = characterStore.characters[get(selectedCharID)];
    if (!char) throw new Error("No character selected");

    const chat = char.chats?.[char.chatPage];
    if (!chat) throw new Error("No active chat found");

    const chatTarget = requireChatTargetFromIndexes(
      get(selectedCharID),
      char.chatPage,
    );
    const chatID = options?.messageIndex ?? -1;
    if (
      !Number.isInteger(chatID) ||
      chatID < -1 ||
      chatID >= chat.message.length
    ) {
      throw new Error(`Invalid messageIndex: ${chatID}`);
    }

    const role = options?.role;
    const cbsConditions: CbsConditions = {
      ...(role ? { chatRole: role } : {}),
      ...(options?.cbsConditions ?? {}),
    };
    const parsed = risuChatParser(text ?? "", {
      chara: char,
      chatID,
      role,
      runVar: options?.runVar,
      rmVar: options?.rmVar,
      tokenizeAccurate: options?.tokenizeAccurate,
      chatTarget,
      cbsConditions,
    });

    if (!options?.processRegex) return parsed;

    return (
      await processScriptFull(
        char,
        parsed,
        "editprocess",
        chatID,
        cbsConditions,
        chatTarget,
      )
    ).data;
  },
  getCurrentLorebookEntries: () => {
    const charId = get(selectedCharID);
    const char = characterStore.characters[charId];
    if (!char) return [];

    const page = char.chatPage;
    const characterLore = char.globalLore ?? [];
    const chatLore = char.chats?.[page]?.localLore ?? [];
    const moduleLore = getModuleLorebooks();
    return $state
      .snapshot(characterLore.concat(chatLore).concat(moduleLore))
      .map(toLegacyLorebook);
  },
  sendChat: async (message: string) => {
    if (typeof message !== "string") {
      throw new Error("Message must be a string");
    }

    if (getModelInfo(presetStore.state.aiModel).id.startsWith("pluginmodel:::"))
    // Executing plugin provider is block because it can be used for loopholes for ipc right now.
    {
      throw new Error(
        "Sending chat with plugin-based model is currently blocked",
      );
    }

    const charId = get(selectedCharID);
    const char = characterStore.characters[charId];
    if (!char) throw new Error("No character selected");

    const chat = char.chats[char.chatPage];
    if (!chat) throw new Error("No active chat found");

    const chatWasNew = !chat.id;
    chat.id ??= v4();
    if (isChatGenerationActive(chat.id)) {
      throw new Error("This chat already has a generation in progress");
    }

    let appendedUserMessage: (typeof chat.message)[number] | undefined;
    if (message) {
      appendedUserMessage = {
        role: "user",
        data: message,
        time: Date.now(),
      };
      chat.message.push(appendedUserMessage);
    }

    if (chatWasNew) {
      await messageStore.persistNewChat(char.chaId, chat.id, chat.message);
    } else if (appendedUserMessage) {
      await messageStore.appendMessage(chat.id, appendedUserMessage);
    }

    const { sendChat: processSendChat } =
      await import("src/ts/process/index.svelte");
    await processSendChat(-1, {
      targetCharacterId: char.chaId,
      targetChatId: chat.id,
    });

    return true;
  },
};
