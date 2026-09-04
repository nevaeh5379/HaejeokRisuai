import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { get, writable } from "svelte/store";
import { saveImage } from "./storage/files/assetPersistence";
import type {
  character,
  groupChat,
  Chat,
  loreBook,
  Message,
} from "./storage/database/schema";
import { defaultSdDataFunc } from "./storage/presets/presetDefaults";
import { safeStructuredClone } from "./polyfill";

import {
  alertAddCharacter,
  alertConfirm,
  alertError,
  alertNormal,
  alertSelect,
  alertStore,
  alertWait,
} from "./alert";
import { language } from "../lang";
import {
  checkNullish,
  findCharacterbyId,
  findCharacterIndexbyId,
  getUserName,
  selectMultipleFile,
  selectSingleFile,
} from "./util";
import { v4 as uuidv4, v4 } from "uuid";
import { getImageType } from "./media";
import {
  MobileGUIStack,
  OpenRealmStore,
  pendingCharID,
  selectedCharID,
  ReloadGUIPointer,
} from "./stores.svelte";
import { characterStore } from "./stores/domain/characterStore.svelte";
import {
  AppendableBuffer,
  changeChatTo,
  checkCharOrder,
  createChatCopyName,
  downloadFile,
  forageStorage,
  getFileSrc,
} from "./globalApi.svelte";
import { updateInlayScreen } from "./process/inlayScreen";
import { parseMarkdownSafe } from "./parser/parser.svelte";
import { translateHTML } from "./translator/translator";
import { importCharacter } from "./characterCards";
import { PngChunk } from "./pngChunk";
import { getColdStorageItem, preLoadChat } from "./process/coldstorage.svelte";
import {
  cancelInactiveChatMessageRelease,
  releaseInactiveChatMessages,
  messageStore,
} from "./stores/domain/messageStore.svelte";
import { createBlankChar } from "./characterDefaults";
import {
  getCharImage,
  getCharImagesBatch,
  preloadCharacterImage,
} from "./characterImage";
import { getProtectedChatIds } from "./memory/chatWorkingSet";
import { getSqlBranchStorage } from "./storage/sql/sqlStorageFactory";
import { buildChatJsonExportPayload } from "./chatExport";
import {
  loadPortableBranchGraphForExport,
  preparePortableChatForBranchRestore,
} from "@risuai/backup-core/portableBranches.cjs";
import { restorePortableChatBranchGraph } from "./storage/sql/portableBranchRestore";

export { createBlankChar } from "./characterDefaults";
export { getCharImage, getCharImagesBatch } from "./characterImage";

export function createNewCharacter() {
  const char = createBlankChar();
  characterStore.characters.push(char);
  checkCharOrder();
  characterStore.markCharacterDirty(char.chaId);
  characterStore.markCharacterOrderDirty();
  return characterStore.characters.length - 1;
}

export function createNewGroup() {
  const char = {
    type: "group" as const,
    name: "",
    firstMessage: "",
    chats: [
      {
        message: [],
        note: "",
        name: "Chat 1",
        localLore: [],
      },
    ],
    chatFolders: [],
    chatPage: 0,
    viewScreen: "none" as const,
    globalLore: [],
    characters: [],
    autoMode: false,
    useCharacterLore: true,
    emotionImages: [],
    customscript: [],
    chaId: uuidv4(),
    firstMsgIndex: -1,
    characterTalks: [],
    characterActive: [],
    realmId: "",
  };
  characterStore.characters.push(char);
  checkCharOrder();
  characterStore.markCharacterDirty(char.chaId);
  characterStore.markCharacterOrderDirty();
  return characterStore.characters.length - 1;
}

export async function selectCharImg(charIndex: number) {
  const selected = await selectSingleFile([
    "png",
    "webp",
    "gif",
    "jpg",
    "jpeg",
  ]);
  if (!selected) {
    return;
  }
  const img = selected.data;
  const targetChar = characterStore.characters[charIndex];

  const type = getImageType(img);

  try {
    if (type === "PNG" && targetChar && targetChar.type === "character") {
      const gen = PngChunk.readGenerator(img);
      const allowedChunk = [
        "parameters",
        "Comment",
        "Title",
        "Description",
        "Author",
        "Software",
        "Source",
        "Disclaimer",
        "Warning",
        "Copyright",
      ];
      for await (const chunk of gen) {
        if (chunk instanceof AppendableBuffer) {
          continue;
        }
        if (!chunk) {
          continue;
        }
        if (chunk.value.length > 20_000) {
          continue;
        }
        if (allowedChunk.includes(chunk.key)) {
          console.log(chunk.key, chunk.value);
          targetChar.extentions ??= {};
          targetChar.extentions.pngExif ??= {};
          targetChar.extentions.pngExif[chunk.key] = chunk.value;
        }
      }
      console.log(targetChar.extentions);
    }
  } catch (error) {
    console.error(error);
  }

  const imgp = await saveImage(img);
  dumpCharImage(charIndex);
  if (characterStore.characters[charIndex]) {
    characterStore.characters[charIndex].image = imgp;
  }
}

export function dumpCharImage(charIndex: number) {
  const char = characterStore.characters[charIndex] as character;
  if (!char || !char.image || char.image === "") {
    return;
  }
  char.ccAssets ??= [];
  char.ccAssets.push({
    type: "icon",
    name: "iconx",
    uri: char.image,
    ext: "png",
  });
  char.image = "";
  characterStore.characters[charIndex] = char;
}

export function changeCharImage(charIndex: number, changeIndex: number) {
  const char = characterStore.characters[charIndex] as character;
  if (!char) return;
  const image = char.ccAssets[changeIndex].uri;
  char.ccAssets.splice(changeIndex, 1);
  dumpCharImage(charIndex);
  char.image = image;
  characterStore.characters[charIndex] = char;
}

export const addingEmotion = writable(false);

export async function addCharEmotion(charId: number) {
  addingEmotion.set(true);
  const selected = await selectMultipleFile(["png", "webp", "gif"]);
  if (!selected) {
    addingEmotion.set(false);
    return;
  }
  for (const f of selected) {
    const img = f.data;
    const imgp = await saveImage(img);
    const name = f.name.replace(".png", "").replace(".webp", "");
    let dbChar = characterStore.characters[charId];
    if (dbChar && dbChar.type !== "group") {
      dbChar.emotionImages.push([name, imgp]);
      characterStore.characters[charId] = dbChar;
    }
  }
  addingEmotion.set(false);
}

export function rmCharEmotion(charId: number, emotionId: number) {
  let dbChar = characterStore.characters[charId];
  if (dbChar && dbChar.type !== "group") {
    dbChar.emotionImages.splice(emotionId, 1);
    characterStore.characters[charId] = dbChar;
  }
}

type ChatExportCharacter = {
  char: character | groupChat;
  index: number;
};

async function hydrateCharacterForChatExport(
  characterId: string,
): Promise<ChatExportCharacter> {
  let index = characterStore.characters.findIndex(
    (candidate) => candidate?.chaId === characterId,
  );
  if (index < 0) {
    throw new Error("Character changed while preparing the chat export");
  }

  let char = characterStore.characters[index];
  if (char.coldstorage) {
    const coldStorageKey = char.coldstorage;
    const coldData = await getColdStorageItem(coldStorageKey);
    if (coldData?.character?.chaId !== characterId) {
      throw new Error(language.errors.coldStorageRestoreFailed);
    }

    index = characterStore.characters.findIndex(
      (candidate) => candidate?.chaId === characterId,
    );
    if (index < 0) {
      throw new Error("Character changed while preparing the chat export");
    }

    char = characterStore.characters[index];
    if (char.coldstorage !== coldStorageKey) {
      throw new Error("Character changed while preparing the chat export");
    }
    characterStore.characters[index] = coldData.character;
    char = coldData.character;
  }

  if (char.detailsLoaded === false) {
    await characterStore.ensureCharacterDetails(characterId);
    index = characterStore.characters.findIndex(
      (candidate) => candidate?.chaId === characterId,
    );
    const hydratedChar =
      index >= 0 ? characterStore.characters[index] : undefined;
    if (!hydratedChar || hydratedChar.detailsLoaded === false) {
      throw new Error(
        `Failed to hydrate character before chat export: ${characterId}`,
      );
    }
    char = hydratedChar;
  }

  return { char, index };
}

function resolveExportChatIndex(
  char: character | groupChat,
  chatId: string | undefined,
  fallbackIndex: number,
): number {
  if (chatId) {
    return char.chats?.findIndex((candidate) => candidate?.id === chatId) ?? -1;
  }
  return char.chats?.[fallbackIndex] ? fallbackIndex : -1;
}

function assertChatReadyForExport(
  chat: Chat | undefined,
  expectedMessageTotal: number | null,
): asserts chat is Chat {
  if (
    !chat ||
    chat.messagesLoaded === false ||
    chat.messagesFullyLoaded === false ||
    chat.detailsLoaded === false ||
    (expectedMessageTotal !== null &&
      (chat.message?.length ?? 0) < expectedMessageTotal)
  ) {
    throw new Error("Could not fully load this chat before exporting it");
  }
}

export async function exportChat(page: number) {
  try {
    const mode = await alertSelect([
      "Export as JSON",
      "Export as TXT",
      "Export as HTML File",
      "Export as HTML Embed",
    ]);
    let jsonExportMode: "compatible" | "native" = "compatible";
    if (mode === "0") {
      const selectedJsonMode = await alertSelect([
        language.exportChatJsonCompatible,
        language.exportChatJsonHaejeok,
      ]);
      if (selectedJsonMode !== "0" && selectedJsonMode !== "1") return;
      jsonExportMode = selectedJsonMode === "1" ? "native" : "compatible";
    }
    const doTranslate =
      mode === "2" || mode === "3"
        ? (await alertSelect([
            language.translateContent,
            language.doNotTranslate,
          ])) === "0"
        : false;
    const anonymous =
      mode === "2" || mode === "3"
        ? (await alertSelect([
            language.includePersonaName,
            language.hidePersonaName,
          ])) === "1"
        : false;
    const selectedID = get(selectedCharID);
    const initialChar = characterStore.characters[selectedID];
    if (!initialChar?.chaId) return;
    const characterId = initialChar.chaId;
    const initialChat = initialChar.chats?.[page];
    const chatId = initialChat?.id;
    const expectedMessageTotal =
      typeof initialChat?.messageTotal === "number"
        ? initialChat.messageTotal
        : null;

    let { char, index: characterIndex } =
      await hydrateCharacterForChatExport(characterId);
    let chatIndex = resolveExportChatIndex(char, chatId, page);
    if (chatIndex < 0) {
      throw new Error("Chat changed while preparing the export");
    }

    await preLoadChat(characterIndex, chatIndex, { full: true });
    ({ char, index: characterIndex } =
      await hydrateCharacterForChatExport(characterId));
    chatIndex = resolveExportChatIndex(char, chatId, page);
    const chat = chatIndex >= 0 ? char.chats[chatIndex] : undefined;
    assertChatReadyForExport(chat, expectedMessageTotal);
    const date = new Date().toJSON();
    const htmlChatParse = async (v: string) => {
      v = parseMarkdownSafe(v);

      if (doTranslate) {
        v = await translateHTML(v, false, "", -1);
      }

      if (anonymous) {
        //case insensitive match, replace all
        const excapedName = char.name.replace(
          /[-\/\\^$*+\?\.()|[\]{}]/g,
          "\\$&",
        );

        v = v.replace(new RegExp(`${excapedName}`, "gi"), "×××");
      }

      return v;
    };

    if (mode === "0") {
      let folders = [];
      if (chat.folderId) {
        folders = char.chatFolders?.filter((f) => f.id === chat.folderId);
      }
      let branchGraph;
      if (jsonExportMode === "native") {
        if (!chat.id) throw new Error("Chat ID is required for branch export");
        const branchStorage = await getSqlBranchStorage();
        branchGraph = await loadPortableBranchGraphForExport(
          chat.id,
          (id) => branchStorage.loadChatBranchGraph(id),
          (id, branchId) =>
            branchStorage.loadBranchMessages(id, branchId, { mode: "full" }),
        );
      }
      const payload = buildChatJsonExportPayload(
        chat,
        jsonExportMode,
        folders,
        branchGraph,
      );
      const stringl = Buffer.from(JSON.stringify(payload), "utf-8");

      const formatSuffix =
        jsonExportMode === "native" ? "haejeok" : "compatible";
      await downloadFile(
        `${char.name}_${date}_chat_${formatSuffix}`.replace(
          /[<>:"/\\|?*\.\,]/g,
          "",
        ) + ".json",
        stringl,
      );
    } else if (mode === "2") {
      let chatContentHTML = "";

      let i = 0;
      for (const v of chat.message) {
        alertWait(`Translating... ${i++}/${chat.message.length}`);
        const name = v.saying
          ? findCharacterbyId(v.saying).name
          : v.role === "char"
            ? char.name
            : anonymous
              ? "×××"
              : getUserName();
        chatContentHTML += `<div class="chat">
                    <h2>${name}</h2>
                    <div>${await htmlChatParse(v.data)}</div>
                </div>`;
      }

      const doc = `
                <!DOCTYPE html>
                <html>
                    <head>
                        <title>${char.name} Chat</title>
                        <style>
                            body{
                                font-family: Arial, sans-serif;
                                display: flex;
                                justify-content: center;
                            }
                            .container{
                                max-width: 800px;
                                padding: 1rem;
                                border-radius: 10px;
                                display: flex;
                                flex-direction: column;
                                gap: 1rem;
                            }
                            .chat{
                                background: #f0f0f0;
                                padding: 1rem;
                                border-radius: 10px;
                                display: flex;
                                flex-direction: column;
                            }
                            .idat{
                                display: none;
                            }
                            h2{
                                margin: 0;
                            }
                            .chat div{
                                margin-top: 0.5rem;
                                break-word: break-all;
                            }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <div class="chat">
                                <h2>${char.name}</h2>
                                <div>${await htmlChatParse(
                                  chat.fmIndex === -1
                                    ? char.firstMessage
                                    : char.alternateGreetings?.[
                                        chat.fmIndex ?? 0
                                      ],
                                )}</div>
                            </div>
                            ${chatContentHTML}
                        </div>
                        <div class="idat">${JSON.stringify(chat)
                          .replace(/</g, "&lt;")
                          .replace(/>/g, "&gt;")}</div>
                    </body>
            `;

      await downloadFile(
        `${char.name}_${date}_chat`.replace(/[<>:"/\\|?*\.\,]/g, "") + ".html",
        Buffer.from(doc, "utf-8"),
      );
    } else if (mode === "3") {
      //create a html table
      let chatContentHTML = "";

      let i = 0;
      for (const v of chat.message) {
        alertWait(`Translating... ${i++}/${chat.message.length}`);
        const name = v.saying
          ? findCharacterbyId(v.saying).name
          : v.role === "char"
            ? char.name
            : anonymous
              ? "×××"
              : getUserName();
        chatContentHTML += `<tr>
                    <td>${name}</td>
                    <td>${await htmlChatParse(v.data)}</td>
                </tr>`;
      }

      const template = `
                <table>
                    <tr>
                        <th>Character</th>
                        <th>Message</th>
                    </tr>
                    <tr>
                        <td>${char.name}</td>
                        <td>${await htmlChatParse(char.firstMessage)}</td>
                    </tr>
                    ${chatContentHTML}
                </table>
                <p>Chat from Risuai</p>
            `;

      //copy to clipboard

      const item = new ClipboardItem({
        "text/html": new Blob([template], { type: "text/html" }),
        "text/plain": new Blob([template], { type: "text/plain" }),
      });
      await navigator.clipboard.write([item]);

      alertNormal(language.clipboardSuccess);
      return;
    } else {
      let stringl = chat.message
        .map((v) => {
          if (v.saying) {
            return `--${findCharacterbyId(v.saying).name}\n${v.data}`;
          } else {
            return `--${v.role === "char" ? char.name : getUserName()}\n${v.data}`;
          }
        })
        .join("\n\n");

      if (char.type !== "group") {
        stringl = `--${char.name}\n${char.firstMessage}\n\n` + stringl;
      }

      await downloadFile(
        `${char.name}_${date}_chat`.replace(/[<>:"/\\|?*\.\,]/g, "") + ".txt",
        Buffer.from(stringl, "utf-8"),
      );
    }
    alertNormal(language.successExport);
  } catch (error) {
    alertError(error);
  }
}

export async function importChat() {
  const dat = await selectSingleFile(["json", "jsonl", "txt", "html"]);
  if (!dat) {
    return;
  }
  try {
    const selectedID = get(selectedCharID);

    if (dat.name.endsWith("jsonl")) {
      const lines = Buffer.from(dat.data).toString("utf-8").split("\n");
      let newChat: Chat = {
        message: [],
        note: "",
        name: "Imported Chat",
        localLore: [],
        fmIndex: -1,
        id: v4(),
      };

      let isFirst = true;
      for (const line of lines) {
        const presedLine = JSON.parse(line);
        if ((presedLine.name && presedLine.is_user, presedLine.mes)) {
          if (!isFirst) {
            newChat.message.push({
              role: presedLine.is_user ? "user" : "char",
              data: formatTavernChat(
                presedLine.mes,
                characterStore.characters[selectedID].name,
              ),
            });
          }
        }

        isFirst = false;
      }

      if (newChat.message.length === 0) {
        alertError(language.errors.noData);
        return;
      }

      if (
        characterStore.characters[selectedID].chatFolders.filter(
          (folder) => folder.id === newChat.folderId,
        ).length === 0
      ) {
        newChat.folderId = null;
      }

      characterStore.characters[selectedID].chats.unshift(newChat);
      if (newChat.id) {
        await messageStore.persistNewChat(
          characterStore.characters[selectedID].chaId,
          newChat.id,
          newChat.message ?? [],
        );
      }
      changeChatTo(0);
      alertNormal(language.successImport);
    } else if (dat.name.endsWith("json")) {
      const json = JSON.parse(Buffer.from(dat.data).toString("utf-8"));
      if (json.type === "haejeokChat" && json.ver === 1) {
        const sourceChat = json.data?.chat as Chat | undefined;
        const branchGraph = json.data?.branchGraph;
        if (
          !sourceChat ||
          !branchGraph ||
          !Array.isArray(branchGraph.branches) ||
          !Array.isArray(branchGraph.messages) ||
          !Array.isArray(branchGraph.links)
        ) {
          alertError(language.errors.noData);
          return;
        }
        const folders = json.folders || [];
        const currentCharacter = characterStore.characters[selectedID];
        const folderIdMap: Record<string, string> = {};
        folders.forEach((folder) => {
          if (currentCharacter.chatFolders?.some((f) => f.id === folder.id)) {
            const newId = uuidv4();
            folderIdMap[folder.id] = newId;
            folder.id = newId;
          } else {
            folderIdMap[folder.id] = folder.id;
          }
        });
        currentCharacter.chatFolders ??= [];
        currentCharacter.chatFolders.push(...folders);

        const newChat = preparePortableChatForBranchRestore(
          sourceChat,
          branchGraph,
        ) as Chat;
        if (newChat.folderId && folderIdMap[newChat.folderId]) {
          newChat.folderId = folderIdMap[newChat.folderId];
        }
        newChat.id = v4();
        currentCharacter.chats.unshift(newChat);
        await messageStore.persistNewChat(
          currentCharacter.chaId,
          newChat.id,
          newChat.message ?? [],
        );
        const branchStorage = await getSqlBranchStorage();
        await restorePortableChatBranchGraph(
          branchStorage,
          newChat.id,
          branchGraph,
        );
        const restoredChat = await branchStorage.loadChat(newChat.id);
        if (restoredChat) currentCharacter.chats[0] = restoredChat;
        changeChatTo(0);
        alertNormal(language.successImport);
        return;
      }
      if (
        (json.type === "risuAllChats" || json.type === "risuChat") &&
        json.ver === 2
      ) {
        const folders = json.folders || [];
        const chats = Array.isArray(json.data) ? json.data : [json.data];
        const selectedID = get(selectedCharID);
        let folderIdMap = {};
        folders.forEach((folder) => {
          if (
            characterStore.characters[selectedID].chatFolders?.some(
              (f) => f.id === folder.id,
            )
          ) {
            const newId = uuidv4();
            folderIdMap[folder.id] = newId;
            folder.id = newId;
          } else {
            folderIdMap[folder.id] = folder.id;
          }
        });
        if (characterStore.characters[selectedID].chatFolders === undefined) {
          characterStore.characters[selectedID].chatFolders = [];
        }
        characterStore.characters[selectedID].chatFolders.push(...folders);
        chats.forEach((chat) => {
          if (chat.folderId && folderIdMap[chat.folderId]) {
            chat.folderId = folderIdMap[chat.folderId];
          }
          chat.id = v4();
        });
        characterStore.characters[selectedID].chats.unshift(...chats);
        await messageStore.persistNewChats(
          characterStore.characters[selectedID].chaId,
          chats
            .filter((chat) => chat.id)
            .map((chat) => ({
              chatId: chat.id!,
              messages: chat.message ?? [],
            })),
        );
        alertNormal(language.successImport);
        return;
      }
      if (json.type === "risuAllChats" && json.ver === 1) {
        const chats = json.data;
        if (Array.isArray(chats) && chats.length > 0) {
          const mappedChats = chats.map((v) => {
            if (!v.id) {
              v.id = uuidv4();
            }
            if (!v.localLore) {
              v.localLore = [];
            }
            v.fmIndex ??= -1;
            return v;
          });
          characterStore.characters[selectedID].chats.unshift(...mappedChats);
          await messageStore.persistNewChats(
            characterStore.characters[selectedID].chaId,
            mappedChats
              .filter((chat) => chat.id)
              .map((chat) => ({
                chatId: chat.id!,
                messages: chat.message ?? [],
              })),
          );
          alertNormal(language.successImport);
          return;
        } else {
          alertError(language.errors.noData);
          return;
        }
      }
      if (json.type === "risuChat" && json.ver === 1) {
        const das: Chat = json.data;
        if (!(
          checkNullish(das.message) ||
          checkNullish(das.note) ||
          checkNullish(das.name) ||
          checkNullish(das.localLore)
        )) {
          das.fmIndex ??= -1;
          das.id = v4();
          characterStore.characters[selectedID].chats.unshift(das);
          if (das.id) {
            await messageStore.persistNewChat(
              characterStore.characters[selectedID].chaId,
              das.id,
              das.message ?? [],
            );
          }
          alertNormal(language.successImport);
          return;
        } else {
          alertError(language.errors.noData);
          return;
        }
      } else {
        alertError(language.errors.noData);
        return;
      }
    } else if (dat.name.endsWith("html")) {
      const doc = new DOMParser().parseFromString(
        Buffer.from(dat.data).toString("utf-8"),
        "text/html",
      );
      const chat = doc.querySelector(".idat")?.textContent;
      if (!chat) {
        alertError(language.errors.noData);
        return;
      }
      const json = JSON.parse(chat);
      if (
        Array.isArray(json?.message) &&
        typeof json?.note === "string" &&
        typeof json?.name === "string" &&
        Array.isArray(json?.localLore)
      ) {
        json.id = v4();
        json.fmIndex ??= -1;
        characterStore.characters[selectedID].chats.unshift(json);
        if (json.id) {
          await messageStore.persistNewChat(
            characterStore.characters[selectedID].chaId,
            json.id,
            json.message ?? [],
          );
        }
        changeChatTo(0);
        alertNormal(language.successImport);
      } else {
        alertError(language.errors.noData);
      }
    }
  } catch (error) {
    alertError(error);
  }
}

export async function exportAllChats() {
  try {
    const selectedID = get(selectedCharID);
    const initialChar = characterStore.characters[selectedID];
    if (!initialChar?.chaId) return;
    const characterId = initialChar.chaId;
    let { char } = await hydrateCharacterForChatExport(characterId);
    const chatTargets = (char.chats ?? []).map((chat, index) => ({
      id: chat?.id,
      fallbackIndex: index,
      expectedMessageTotal:
        typeof chat?.messageTotal === "number" ? chat.messageTotal : null,
    }));

    for (const target of chatTargets) {
      const resolved = await hydrateCharacterForChatExport(characterId);
      const chatIndex = resolveExportChatIndex(
        resolved.char,
        target.id,
        target.fallbackIndex,
      );
      if (chatIndex < 0) {
        throw new Error("Chats changed while preparing the export");
      }
      await preLoadChat(resolved.index, chatIndex, { full: true });

      const loaded = await hydrateCharacterForChatExport(characterId);
      const loadedChatIndex = resolveExportChatIndex(
        loaded.char,
        target.id,
        target.fallbackIndex,
      );
      const loadedChat =
        loadedChatIndex >= 0 ? loaded.char.chats[loadedChatIndex] : undefined;
      assertChatReadyForExport(loadedChat, target.expectedMessageTotal);
    }

    ({ char } = await hydrateCharacterForChatExport(characterId));
    if (char.chats.length !== chatTargets.length) {
      throw new Error("Chats changed while preparing the export");
    }
    for (const target of chatTargets) {
      const finalChatIndex = resolveExportChatIndex(
        char,
        target.id,
        target.fallbackIndex,
      );
      const finalChat =
        finalChatIndex >= 0 ? char.chats[finalChatIndex] : undefined;
      assertChatReadyForExport(finalChat, target.expectedMessageTotal);
    }
    const date = new Date().toISOString().replace(/[:.]/g, "-");
    const allChats = char.chats;
    const allFolders = char.chatFolders;
    const stringl = Buffer.from(
      JSON.stringify({
        type: "risuAllChats",
        ver: 2,
        data: allChats,
        folders: allFolders,
      }),
      "utf-8",
    );
    await downloadFile(
      `${char.name}_all_chats_${date}`.replace(/[<>:"/\\|?*.,]/g, "") + ".json",
      stringl,
    );
    alertNormal(language.successExport);
  } catch (error) {
    alertError(error);
  }
}

function formatTavernChat(chat: string, charName: string) {
  return chat
    .replace(/<([Uu]ser)>|\{\{([Uu]ser)\}\}/g, getUserName())
    .replace(/((\{\{)|<)([Cc]har)(=.+)?((\}\})|>)/g, charName);
}

const formattedCharacters = new WeakSet<object>();

export function characterFormatUpdate(
  indexOrCharacter: number | character,
  arg: {
    updateInteraction?: boolean;
  } = {},
) {
  let cha =
    typeof indexOrCharacter === "number"
      ? characterStore.getCharacterByIndex(indexOrCharacter)
      : indexOrCharacter;
  const characterIndex =
    typeof indexOrCharacter === "number" ? indexOrCharacter : null;
  if (formattedCharacters.has(cha)) {
    if (arg.updateInteraction) {
      const interactionTime = Date.now();
      if (characterIndex !== null) {
        characterStore.touchCharacterInteraction(
          characterIndex,
          interactionTime,
        );
      } else {
        cha.lastInteraction = interactionTime;
      }
    }
    return cha;
  }

  // SQL lazy hydration already gives us the persisted character object. Most of
  // the assignments below are runtime default normalization and must not turn a
  // first visit into a rewrite of every asset/lore/script relational row.
  const sqlHydrated = characterIndex !== null && cha.detailsLoaded === true;
  let needsFullCharacterPersistence = false;
  let chatManifestChanged = false;
  const dirtyChatIds = new Set<string>();

  if (cha.chats.length === 0) {
    cha.chats = [
      {
        message: [],
        note: "",
        name: "Chat 1",
        localLore: [],
      },
    ];
    chatManifestChanged = true;
  }
  if (!cha.chats[cha.chatPage]) {
    cha.chatPage = 0;
    needsFullCharacterPersistence = true;
  }
  if (!cha.chats[cha.chatPage].message) {
    cha.chats[cha.chatPage].message = [];
  }
  if (!cha.type) {
    cha.type = "character";
    needsFullCharacterPersistence = true;
  }
  if (!cha.chaId) {
    cha.chaId = uuidv4();
    needsFullCharacterPersistence = true;
  }
  if (cha.type !== "group") {
    if (checkNullish(cha.sdData)) {
      cha.sdData = defaultSdDataFunc();
    }
    if (checkNullish(cha.utilityBot)) {
      cha.utilityBot = false;
    }
    cha.triggerscript = cha.triggerscript ?? [];
    cha.alternateGreetings = cha.alternateGreetings ?? [];
    cha.exampleMessage = cha.exampleMessage ?? "";
    cha.creatorNotes = cha.creatorNotes ?? "";
    cha.systemPrompt = cha.systemPrompt ?? "";
    cha.tags = cha.tags ?? [];
    cha.creator = cha.creator ?? "";
    cha.characterVersion = cha.characterVersion ?? "";
    cha.personality = cha.personality ?? "";
    cha.scenario = cha.scenario ?? "";
    cha.firstMsgIndex = cha.firstMsgIndex ?? -1;
    cha.additionalData = cha.additionalData ?? {
      tag: [],
      creator: "",
      character_version: "",
    };
    cha.voicevoxConfig = cha.voicevoxConfig ?? {
      SPEED_SCALE: 1,
      PITCH_SCALE: 0,
      INTONATION_SCALE: 1,
      VOLUME_SCALE: 1,
    };
    if (cha.postHistoryInstructions) {
      cha.chats[cha.chatPage].note += "\n" + cha.postHistoryInstructions;
      cha.chats[cha.chatPage].note = cha.chats[cha.chatPage].note.trim();
      cha.postHistoryInstructions = null;
      needsFullCharacterPersistence = true;
      const activeChatId = cha.chats[cha.chatPage].id;
      if (activeChatId) dirtyChatIds.add(activeChatId);
    }
    cha.additionalText ??= "";
    cha.depth_prompt ??= {
      depth: 0,
      prompt: "",
    };
    cha.hfTTS ??= {
      model: "",
      language: "en",
    };
    cha.backgroundHTML ??= "";
    cha.backgroundCSS ??= "";
    cha.creation_date ??= Date.now();
    // Lore normalization can touch a very large tree. Apply the legacy migration
    // in memory, but do not rewrite every lore/asset row merely because the bot
    // was opened; a later real character edit will persist the normalized form.
    cha.globalLore = updateLorebooks(cha.globalLore ?? []);
    if (!cha.newGenData) {
      cha = updateInlayScreen(cha);
    }
    // Migrate legacy 'none' value to '' for UI dropdown compatibility.
    if (cha.ttsMode === "none") {
      // Compatibility-only runtime normalization. Persisting this tiny legacy
      // value during selection would rewrite the entire character tree.
      cha.ttsMode = "";
    }
    cha.ttsMode ??= "";
  } else {
    if (
      !cha.characterTalks ||
      cha.characterTalks.length !== cha.characters.length
    ) {
      cha.characterTalks = [];
      for (let i = 0; i < cha.characters.length; i++) {
        cha.characterTalks.push((1 / 6) * 4);
      }
      needsFullCharacterPersistence = true;
    }
    if (
      !cha.characterActive ||
      cha.characterActive.length !== cha.characters.length
    ) {
      cha.characterActive = [];
      for (let i = 0; i < cha.characters.length; i++) {
        cha.characterActive.push(true);
      }
      needsFullCharacterPersistence = true;
    }
  }
  if (checkNullish(cha.customscript)) {
    cha.customscript = [];
  }

  for (let i = 0; i < cha.chats.length; i++) {
    const chat = cha.chats[i];
    // SQL selection intentionally keeps inactive chats as shallow summaries.
    // Never normalize or persist those placeholders: missing localLore/fmIndex
    // means "not hydrated", not "empty". Treating them as edits rewrites every
    // chat on character selection and can destroy unloaded extension metadata.
    if (sqlHydrated && chat.detailsLoaded === false) continue;

    let chatChanged = false;
    if (chat.fmIndex === undefined || chat.fmIndex === null) {
      chat.fmIndex = cha.firstMsgIndex ?? -1;
      chatChanged = true;
    }
    if (!chat.id) {
      chat.id = uuidv4();
      chatChanged = true;
      chatManifestChanged = true;
    }
    if (!chat.localLore) {
      chat.localLore = [];
      chatChanged = true;
    }
    if (chatChanged && chat.id) dirtyChatIds.add(chat.id);
  }

  const interactionTime = arg.updateInteraction ? Date.now() : null;
  if (
    interactionTime !== null &&
    (!sqlHydrated || needsFullCharacterPersistence)
  ) {
    cha.lastInteraction = interactionTime;
  }
  formattedCharacters.add(cha);

  if (characterIndex !== null) {
    if (!sqlHydrated) {
      // Legacy/non-SQL objects retain the historical eager persistence path.
      characterStore.setCharacterByIndex(characterIndex, cha);
    } else {
      if (needsFullCharacterPersistence) {
        characterStore.markCharacterDirty(cha.chaId);
      } else if (interactionTime !== null) {
        characterStore.touchCharacterInteraction(
          characterIndex,
          interactionTime,
        );
      }
      for (const chatId of dirtyChatIds) characterStore.markChatDirty(chatId);
      if (chatManifestChanged) {
        characterStore.markChatManifestDirty(cha.chaId);
      }
    }
  }
  return cha;
}

export function updateLorebooks(book: loreBook[]) {
  if (!book.some((v) => (v.bookVersion ?? 1) < 2)) {
    return book;
  }
  return book.map((v) => {
    v.bookVersion ??= 1;
    if (v.bookVersion >= 2) {
      return v;
    }
    if (v.activationPercent) {
      const perc = v.activationPercent;
      v.activationPercent = null;

      v.content = `@@probability ${perc}\n${v.content}`;
    }
    v.content = v.content
      .replace(/@@@?end/g, "@@depth 0")
      .replace(/\<(char|bot)\>/g, "{{char}}")
      .replace(/\<(user)\>/g, "{{user}}");
    v.bookVersion = 2;
    return v;
  });
}

export async function makeGroupImage() {
  try {
    alertStore.set({
      type: "wait",
      msg: `Loading..`,
    });
    const charID = get(selectedCharID);
    const group = characterStore.characters[charID];
    if (group.type !== "group") {
      return;
    }

    const imageUrls = await Promise.all(
      group.characters.map((v) => {
        return getCharImage(findCharacterbyId(v).image, "plain");
      }),
    );

    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");

    // Load the images
    const images = [];
    let loadedImages = 0;

    await Promise.all(
      imageUrls.map(
        (url) =>
          new Promise<void>((resolve) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => {
              images.push(img);
              resolve();
            };
            img.src = url;
          }),
      ),
    );

    // Calculate dimensions and draw the grid
    const numImages = images.length;
    const numCols = Math.ceil(Math.sqrt(images.length));
    const numRows = Math.ceil(images.length / numCols);
    const cellWidth = canvas.width / numCols;
    const cellHeight = canvas.height / numRows;

    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < numCols; col++) {
        const index = row * numCols + col;
        if (index >= numImages) break;
        ctx.drawImage(
          images[index],
          col * cellWidth,
          row * cellHeight,
          cellWidth,
          cellHeight,
        );
      }
    }

    // Return the image URI

    const uri = canvas.toDataURL();
    canvas.remove();
    characterStore.characters[charID].image = await saveImage(
      dataURLtoBuffer(uri),
    );
    alertStore.set({
      type: "none",
      msg: "",
    });
  } catch (error) {
    alertError(error);
  }
}

function dataURLtoBuffer(string: string) {
  const regex = /^data:.+\/(.+);base64,(.*)$/;

  const matches = string.match(regex);
  const ext = matches[1];
  const data = matches[2];
  return Buffer.from(data, "base64");
}

export async function removeChar(
  identifier: string | number,
  name: string,
  type: "normal" | "permanent" | "permanentForce" = "normal",
) {
  if (type !== "permanentForce") {
    const conf = await alertConfirm(language.removeConfirm + name);
    if (!conf) {
      return;
    }
    const conf2 = await alertConfirm(language.removeConfirm2 + name);
    if (!conf2) {
      return;
    }
  }
  let chars = characterStore.characters;
  // Resolve identifier to actual index at the time of deletion to avoid
  // race conditions when concurrent deletions shift the array.
  const index =
    typeof identifier === "string"
      ? findCharacterIndexbyId(identifier)
      : identifier;
  if (index === -1 || index >= chars.length) {
    return;
  }
  if (type === "normal") {
    chars[index].trashTime = Date.now();
    characterStore.markCharacterDirty(chars[index].chaId);
  } else {
    chars.splice(index, 1);
  }
  checkCharOrder();
  characterStore.characters = chars;
  characterStore.markCharacterOrderDirty();
  selectedCharID.set(-1);
}

export async function addCharacter(
  arg: {
    reseter?: () => any;
  } = {},
) {
  MobileGUIStack.set(100);
  const reseter = arg.reseter ?? (() => {});
  const r = await alertAddCharacter();
  if (r === "importFromRealm") {
    selectedCharID.set(-1);
    OpenRealmStore.set(true);
    MobileGUIStack.set(0);
    return;
  }
  reseter();
  switch (r) {
    case "createfromScratch":
      createNewCharacter();
      break;
    case "createGroup":
      createNewGroup();
      break;
    case "importCharacter":
      await importCharacter();
      break;
    default:
      MobileGUIStack.set(1);
      return;
  }
  if (characterStore.characters[characterStore.characters.length - 1]) {
    changeChar(characterStore.characters.length - 1);
  }
  MobileGUIStack.set(1);
}

export async function changeChar(
  index: number,
  arg: {
    reseter?: () => any;
    chatId?: string;
  } = {},
) {
  const reseter = arg.reseter ?? (() => {});
  // Do not let the previous character's idle eviction/GC work compete with
  // SQL hydration and first paint for the character we are opening now.
  cancelInactiveChatMessageRelease();
  characterStore.cancelInactiveCharacterDetailRelease();
  void preloadCharacterImage(characterStore.characters?.[index]?.image);
  reseter();
  pendingCharID.set(index);
  const modulePromise = import("./process/modules");
  if (characterStore.characters?.[index]?.coldstorage) {
    const coldData = await getColdStorageItem(
      characterStore.characters[index].coldstorage!,
    );
    if (
      coldData?.character &&
      coldData.character.chaId === characterStore.characters[index].chaId
    ) {
      characterStore.characters[index] = coldData.character;
    } else {
      alertError(language.errors.coldStorageRestoreFailed);
      if (get(pendingCharID) === index) {
        pendingCharID.set(-1);
      }
      return;
    }
  }
  try {
    const targetCharacter = characterStore.characters?.[index];
    if (targetCharacter?.detailsLoaded === false && targetCharacter.chaId) {
      await characterStore.ensureCharacterDetails(targetCharacter.chaId);
    }
  } catch (error) {
    console.error(`SQL loadCharacter failed for character ${index}:`, error);
    if (get(pendingCharID) === index) {
      pendingCharID.set(-1);
    }
    throw error;
  }
  if (get(pendingCharID) !== index) {
    return;
  }

  const currentChar = characterStore.characters?.[index];
  if (arg.chatId && currentChar?.chats) {
    const requestedChatIndex = currentChar.chats.findIndex(
      (chat) => chat.id === arg.chatId,
    );
    if (requestedChatIndex >= 0) currentChar.chatPage = requestedChatIndex;
  }
  characterFormatUpdate(index, {
    updateInteraction: true,
  });
  const currentChatPage = currentChar?.chatPage ?? 0;
  const activeChatId = currentChar?.chats?.[currentChatPage]?.id;

  // Start the active chat read before mounting ChatScreen so native SQLite I/O
  // overlaps the first render instead of beginning one frame later in {#await}.
  void preLoadChat(index, currentChatPage);

  // Character metadata is sufficient to mount the shell. Module chunk loading
  // is independent and must not hold navigation hostage on a cold first click.
  selectedCharID.set(index);
  pendingCharID.set(-1);
  if (arg.chatId) {
    changeChatTo(arg.chatId);
  }
  const getProtectedIds = () => getProtectedChatIds([activeChatId]);
  releaseInactiveChatMessages(getProtectedIds);
  characterStore.releaseInactiveCharacterDetails(getProtectedIds);

  void modulePromise
    .then(({ moduleUpdate }) => {
      if (get(selectedCharID) === index) {
        moduleUpdate(index, { reloadMessages: false });
      }
    })
    .catch((error) => console.error("Failed to load character modules", error));
}

export async function duplicateChat(
  characterIndex: number,
  chatIndex: number,
  options: { selectNew?: boolean; insertIndex?: number } = {},
): Promise<Chat | null> {
  const initialChar = characterStore.characters[characterIndex];
  if (!initialChar?.chats || !initialChar.chaId) return null;
  const initialSourceChat = initialChar.chats[chatIndex];
  if (!initialSourceChat) return null;

  const characterId = initialChar.chaId;
  const sourceChatId = initialSourceChat.id;
  const expectedMessageTotal =
    initialSourceChat.messagesFullyLoaded === false &&
    typeof initialSourceChat.messageTotal === "number"
      ? initialSourceChat.messageTotal
      : null;

  // Lazy chat hydration can fail without throwing because preLoadChat is also used
  // by ordinary UI reads. Verify the postcondition before creating a permanent copy.
  await preLoadChat(characterIndex, chatIndex, { full: true });

  // The await above gives realtime sync/reordering a chance to move the chat. Re-find
  // both the character and chat by stable identity instead of trusting stale indexes.
  const char = characterStore.characters.find(
    (candidate) => candidate?.chaId === characterId,
  );
  if (!char?.chats) return null;
  const sourceIndex = sourceChatId
    ? char.chats.findIndex((chat) => chat?.id === sourceChatId)
    : char.chats.indexOf(initialSourceChat);
  const sourceChat = sourceIndex >= 0 ? char.chats[sourceIndex] : undefined;
  if (!sourceChat) return null;

  if (
    sourceChat.messagesLoaded === false ||
    sourceChat.messagesFullyLoaded === false ||
    sourceChat.detailsLoaded === false ||
    (expectedMessageTotal !== null &&
      sourceChat.message.length < expectedMessageTotal)
  ) {
    const error = new Error(
      "Could not fully load this chat before duplicating it. The original chat was left unchanged.",
    );
    console.error("[duplicateChat] Chat hydration did not complete", {
      characterId,
      sourceChatId,
      sourceIndex,
      expectedMessageTotal,
      loadedMessages: sourceChat.message.length,
    });
    alertError(error);
    return null;
  }

  const newChat: Chat = safeStructuredClone(sourceChat);
  newChat.id = uuidv4();
  newChat.name = createChatCopyName(
    sourceChat.name || "Chat",
    "Copy",
    char.chats,
  );
  newChat.branch = undefined;
  newChat.branchState = undefined;
  newChat.isStreaming = false;
  newChat.activeStreamingDisplayOptimizationMode = undefined;
  newChat.preventMessageCompaction = undefined;

  const idMap = new Map<string, string>();
  const messages = newChat.message ?? [];
  for (const msg of messages) {
    const oldId = msg.chatId;
    const newId = uuidv4();
    msg.chatId = newId;
    // Legacy data can contain duplicate message IDs. Relational persistence keeps
    // the first occurrence stable, so bookmark remapping must follow the same rule.
    if (oldId && !idMap.has(oldId)) idMap.set(oldId, newId);
  }

  if (Array.isArray(newChat.bookmarks)) {
    newChat.bookmarks = newChat.bookmarks
      .map((id) => idMap.get(id))
      .filter((id): id is string => typeof id === "string");
  }
  if (newChat.bookmarkNames && typeof newChat.bookmarkNames === "object") {
    const nextBookmarkNames: { [key: string]: string } = {};
    for (const [oldId, name] of Object.entries(newChat.bookmarkNames)) {
      const nextId = idMap.get(oldId);
      if (nextId) nextBookmarkNames[nextId] = name;
    }
    newChat.bookmarkNames = nextBookmarkNames;
  }

  newChat.messagesLoaded = true;
  newChat.messagesFullyLoaded = true;
  newChat.messageOffset = 0;
  newChat.messageTotal = messages.length;
  newChat.detailsLoaded = true;

  const selectNew = options.selectNew ?? false;
  const requestedInsertIndex =
    options.insertIndex ?? (selectNew ? 0 : sourceIndex + 1);
  const insertIndex = Math.max(
    0,
    Math.min(requestedInsertIndex, char.chats.length),
  );
  const activeChatIndex = char.chatPage ?? 0;

  char.chats.splice(insertIndex, 0, newChat);
  if (!selectNew && insertIndex <= activeChatIndex) {
    char.chatPage = activeChatIndex + 1;
  }
  characterStore.markChatDirty(newChat.id);
  characterStore.markChatManifestDirty(characterId);
  characterStore.markCharacterDirty(characterId);
  await messageStore.persistNewChat(
    characterId,
    newChat.id,
    newChat.message ?? [],
  );

  const selectedCharacter = characterStore.characters[get(selectedCharID)];
  if (selectNew) {
    if (selectedCharacter?.chaId === characterId) {
      changeChatTo(insertIndex);
    } else {
      char.chatPage = insertIndex;
    }
  } else if (selectedCharacter?.chaId === characterId) {
    ReloadGUIPointer.set(Math.random());
  }

  return newChat;
}

export async function duplicateCharacter(
  characterIndex: number,
  options: { selectNew?: boolean } = {},
): Promise<character | groupChat | null> {
  const initialChar = characterStore.characters[characterIndex];
  if (!initialChar?.chaId) return null;

  const characterId = initialChar.chaId;
  const findSourceIndex = () =>
    characterStore.characters.findIndex(
      (candidate) => candidate.chaId === characterId,
    );
  const findSourceCharacter = () => {
    const index = findSourceIndex();
    return index >= 0 ? characterStore.characters[index] : undefined;
  };
  const failHydration = (
    message: string,
    details?: Record<string, unknown>,
  ) => {
    const error = new Error(message);
    console.error("[duplicateCharacter] Hydration did not complete", {
      characterId,
      ...details,
    });
    alertError(error);
    return null;
  };

  if (initialChar.coldstorage) {
    const coldData = await getColdStorageItem(initialChar.coldstorage);
    const currentIndex = findSourceIndex();
    if (currentIndex < 0) return null;
    if (coldData?.character?.chaId === characterId) {
      characterStore.characters[currentIndex] = coldData.character;
    } else {
      alertError(language.errors.coldStorageRestoreFailed);
      return null;
    }
  }

  let sourceChar = findSourceCharacter();
  if (!sourceChar) return null;
  if (sourceChar.detailsLoaded === false) {
    try {
      await characterStore.ensureCharacterDetails(characterId);
    } catch (error) {
      console.error(
        "[duplicateCharacter] Failed to ensure character details:",
        error,
      );
      alertError(error);
      return null;
    }
    sourceChar = findSourceCharacter();
    if (!sourceChar || sourceChar.detailsLoaded === false) {
      return failHydration(
        "Could not fully load character details before duplicating. The original character was left unchanged.",
      );
    }
  }

  type ChatTarget = {
    id?: string;
    ref: Chat;
    expectedMessageTotal: number | null;
  };
  const chatTargets: ChatTarget[] = (sourceChar.chats ?? []).map((chat) => ({
    id: chat.id,
    ref: chat,
    expectedMessageTotal:
      typeof chat.messageTotal === "number" ? chat.messageTotal : null,
  }));

  const resolveChatIndex = (
    char: character | groupChat,
    ref: Chat,
    id?: string,
  ) => {
    const byReference = char.chats?.indexOf(ref) ?? -1;
    if (byReference >= 0) return byReference;
    if (!id) return -1;

    let match = -1;
    for (let i = 0; i < (char.chats?.length ?? 0); i++) {
      if (char.chats[i]?.id !== id) continue;
      if (match >= 0) return -1;
      match = i;
    }
    return match;
  };

  for (const target of chatTargets) {
    const currentCharacterIndex = findSourceIndex();
    if (currentCharacterIndex < 0) return null;
    const currentChar = characterStore.characters[currentCharacterIndex];
    const chatIndex = resolveChatIndex(currentChar, target.ref, target.id);
    if (chatIndex < 0) {
      return failHydration(
        "Character chats changed while preparing the duplicate. Please try again.",
        { chatId: target.id },
      );
    }

    const chatBeforeLoad = currentChar.chats[chatIndex];
    const expectedMessageTotal =
      typeof chatBeforeLoad.messageTotal === "number"
        ? chatBeforeLoad.messageTotal
        : target.expectedMessageTotal;

    await preLoadChat(currentCharacterIndex, chatIndex, { full: true });

    const loadedChar = findSourceCharacter();
    if (!loadedChar) return null;
    const loadedChatIndex = resolveChatIndex(
      loadedChar,
      chatBeforeLoad,
      target.id,
    );
    const loadedChat =
      loadedChatIndex >= 0 ? loadedChar.chats[loadedChatIndex] : undefined;
    if (
      !loadedChat ||
      loadedChat.messagesLoaded === false ||
      loadedChat.messagesFullyLoaded === false ||
      loadedChat.detailsLoaded === false ||
      (expectedMessageTotal !== null &&
        (loadedChat.message?.length ?? 0) < expectedMessageTotal)
    ) {
      return failHydration(
        "Could not fully load character chats before duplicating. The original character was left unchanged.",
        {
          chatId: target.id,
          expectedMessageTotal,
          loadedMessages: loadedChat?.message?.length ?? 0,
        },
      );
    }
  }

  sourceChar = findSourceCharacter();
  if (!sourceChar) return null;
  if (sourceChar.chats.length !== chatTargets.length) {
    return failHydration(
      "Character chats changed while preparing the duplicate. Please try again.",
      {
        expectedChats: chatTargets.length,
        actualChats: sourceChar.chats.length,
      },
    );
  }

  const resolvedChatIndexes = chatTargets.map((target) =>
    resolveChatIndex(sourceChar!, target.ref, target.id),
  );
  if (
    resolvedChatIndexes.some((index) => index < 0) ||
    new Set(resolvedChatIndexes).size !== chatTargets.length
  ) {
    return failHydration(
      "Character chats changed while preparing the duplicate. Please try again.",
    );
  }

  const newChar: character | groupChat = safeStructuredClone(sourceChar);
  newChar.chaId = uuidv4();
  newChar.name = createChatCopyName(
    sourceChar.name || "Character",
    "Copy",
    characterStore.characters,
  );
  newChar.lastInteraction = Date.now();
  newChar.detailsLoaded = true;
  newChar.trashTime = undefined;

  const newChats: Chat[] = [];
  const chatsToPersist: Array<{ chatId: string; messages: Message[] }> = [];

  for (const chat of newChar.chats ?? []) {
    const newChat: Chat = { ...chat };
    newChat.id = uuidv4();
    newChat.branch = undefined;
    newChat.branchState = undefined;
    newChat.isStreaming = false;
    newChat.activeStreamingDisplayOptimizationMode = undefined;
    newChat.preventMessageCompaction = undefined;

    const idMap = new Map<string, string>();
    const messages = (newChat.message ?? []).map((msg) => {
      const oldId = msg.chatId;
      const newId = uuidv4();
      const clonedMsg = { ...msg, chatId: newId };
      if (oldId && !idMap.has(oldId)) idMap.set(oldId, newId);
      return clonedMsg;
    });

    newChat.message = messages;

    if (Array.isArray(newChat.bookmarks)) {
      newChat.bookmarks = newChat.bookmarks
        .map((id) => idMap.get(id))
        .filter((id): id is string => typeof id === "string");
    }
    if (newChat.bookmarkNames && typeof newChat.bookmarkNames === "object") {
      const nextBookmarkNames: { [key: string]: string } = {};
      for (const [oldId, name] of Object.entries(newChat.bookmarkNames)) {
        const nextId = idMap.get(oldId);
        if (nextId) nextBookmarkNames[nextId] = name;
      }
      newChat.bookmarkNames = nextBookmarkNames;
    }

    newChat.messagesLoaded = true;
    newChat.messagesFullyLoaded = true;
    newChat.messageOffset = 0;
    newChat.messageTotal = messages.length;
    newChat.detailsLoaded = true;

    newChats.push(newChat);
    if (newChat.id) {
      chatsToPersist.push({ chatId: newChat.id, messages: newChat.message });
    }
  }

  newChar.chats = newChats;

  characterStore.characters.push(newChar);
  checkCharOrder();
  characterStore.markCharacterDirty(newChar.chaId);
  characterStore.markCharacterOrderDirty();

  for (const chat of newChats) {
    if (chat.id) {
      characterStore.markChatDirty(chat.id);
    }
  }
  characterStore.markChatManifestDirty(newChar.chaId);

  if (chatsToPersist.length > 0) {
    await messageStore.persistNewChats(newChar.chaId, chatsToPersist);
  }

  const newIndex = characterStore.characters.findIndex(
    (candidate) => candidate.chaId === newChar.chaId,
  );
  if (options.selectNew && newIndex >= 0) {
    await changeChar(newIndex);
  }

  return newChar;
}
