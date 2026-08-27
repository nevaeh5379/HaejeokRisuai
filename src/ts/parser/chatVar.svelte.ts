import { get } from "svelte/store";
import { selectedCharID } from "../stores.svelte";
import { parseKeyValue } from "../util";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";

export type ChatVarTarget = {
  characterIndex: number;
  chatIndex: number;
  /** Request-local variable overlay used by isolated generations such as /btw. */
  globalVariables?: Record<string, string>;
};

export function getChatVar(key: string, target?: ChatVarTarget): string {
  const selectedChar = target?.characterIndex ?? get(selectedCharID);
  const char = characterStore.characters[selectedChar];
  if (!char) {
    return "null";
  }
  const chat = char.chats[target?.chatIndex ?? char.chatPage];
  if (!chat) {
    return "null";
  }
  chat.scriptstate ??= {};
  const state = chat.scriptstate["$" + key];
  if (state === undefined || state === null) {
    const defaultVariables = parseKeyValue(char.defaultVariables).concat(
      parseKeyValue(settingsStore.state.templateDefaultVariables),
    );
    const findResult = defaultVariables.find((f) => {
      return f[0] === key;
    });
    if (findResult) {
      return findResult[1];
    }
    return "null";
  }
  return state.toString();
}

export function setChatVar(
  key: string,
  value: string,
  target?: ChatVarTarget,
): boolean {
  const selectedChar = target?.characterIndex ?? get(selectedCharID);
  const char = characterStore.characters[selectedChar];
  if (!char || !char.chats) {
    return false;
  }
  const chat = char.chats[target?.chatIndex ?? char.chatPage];
  if (!chat) {
    return false;
  }
  chat.scriptstate ??= {};

  const stateKey = "$" + key;
  if (chat.scriptstate[stateKey] === value) {
    return false;
  }

  chat.scriptstate[stateKey] = value;
  return true;
}

function getCurrentChatForVars(target?: ChatVarTarget) {
  const selectedChar = target?.characterIndex ?? get(selectedCharID);
  const char = characterStore.characters[selectedChar];
  return char?.chats?.[target?.chatIndex ?? char.chatPage];
}

export function getGLChatVar(
  key: string,
  target?: ChatVarTarget,
): string | undefined {
  return getCurrentChatForVars(target)?.GLGlobalVariables?.[key];
}

export function setGLChatVar(key: string, value: string): boolean {
  const chat = getCurrentChatForVars();
  if (!chat) {
    return false;
  }
  chat.GLGlobalVariables ??= {};
  if (chat.GLGlobalVariables[key] === value) {
    return false;
  }
  chat.GLGlobalVariables[key] = value;
  return true;
}

export function getGlobalChatVar(key: string, target?: ChatVarTarget): string {
  const requestValue = target?.globalVariables?.[key];
  if (requestValue !== undefined) return requestValue;
  const localValue = getGLChatVar(key, target);
  if (localValue !== undefined) {
    return localValue;
  }
  return settingsStore.state.globalChatVariables?.[key] ?? "null";
}

export function setGlobalChatVar(key: string, value: string): boolean {
  const chat = getCurrentChatForVars();
  if (chat?.useLocallySetGlobalVariables) {
    return setGLChatVar(key, value);
  }

  if (chat?.GLGlobalVariables && key in chat.GLGlobalVariables) {
    delete chat.GLGlobalVariables[key];
  }

  settingsStore.state.globalChatVariables ??= {};
  if (settingsStore.state.globalChatVariables[key] === value) {
    return false;
  }
  settingsStore.state.globalChatVariables[key] = value;
  return true;
}

export function isLocallyHandledGlobalChatVar(key: string): boolean {
  return getGLChatVar(key) !== undefined;
}

export function removeLocallyHandledGlobalChatVar(key: string): boolean {
  const chat = getCurrentChatForVars();
  if (!chat?.GLGlobalVariables || !(key in chat.GLGlobalVariables)) {
    return false;
  }
  delete chat.GLGlobalVariables[key];
  return true;
}
