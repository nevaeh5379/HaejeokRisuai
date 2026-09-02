import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import { parseKeyValue } from "../util";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import {
  resolveChatTarget,
  resolveSelectedChatTarget,
  type ChatExecutionTarget,
} from "../chatTarget";

function resolveVariableTarget(target?: ChatExecutionTarget) {
  return target ? resolveChatTarget(target) : resolveSelectedChatTarget();
}

export function getChatVar(key: string, target?: ChatExecutionTarget): string {
  const resolved = resolveVariableTarget(target);
  if (!resolved) {
    return "null";
  }
  const { character: char, chat } = resolved;
  chat.scriptstate ??= {};
  const state = chat.scriptstate["$" + key];
  if (state === undefined || state === null) {
    const defaultVariables = parseKeyValue(char.defaultVariables).concat(
      parseKeyValue(presetStore.state.templateDefaultVariables),
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
  target?: ChatExecutionTarget,
): boolean {
  const resolved = resolveVariableTarget(target);
  if (!resolved) {
    return false;
  }
  const { chat } = resolved;
  chat.scriptstate ??= {};

  const stateKey = "$" + key;
  if (chat.scriptstate[stateKey] === value) {
    return false;
  }

  chat.scriptstate[stateKey] = value;
  return true;
}

function getCurrentChatForVars(target?: ChatExecutionTarget) {
  return resolveVariableTarget(target)?.chat;
}

export function getGLChatVar(
  key: string,
  target?: ChatExecutionTarget,
): string | undefined {
  return getCurrentChatForVars(target)?.GLGlobalVariables?.[key];
}

export function setGLChatVar(
  key: string,
  value: string,
  target?: ChatExecutionTarget,
): boolean {
  const chat = getCurrentChatForVars(target);
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

export function getGlobalChatVar(key: string, target?: ChatExecutionTarget): string {
  const requestValue = target?.globalVariables?.[key];
  if (requestValue !== undefined) return requestValue;
  const localValue = getGLChatVar(key, target);
  if (localValue !== undefined) {
    return localValue;
  }
  return settingsStore.state.globalChatVariables?.[key] ?? "null";
}

export function setGlobalChatVar(
  key: string,
  value: string,
  target?: ChatExecutionTarget,
): boolean {
  const chat = getCurrentChatForVars(target);
  if (chat?.useLocallySetGlobalVariables) {
    return setGLChatVar(key, value, target);
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

export function isLocallyHandledGlobalChatVar(
  key: string,
  target?: ChatExecutionTarget,
): boolean {
  return getGLChatVar(key, target) !== undefined;
}

export function removeLocallyHandledGlobalChatVar(
  key: string,
  target?: ChatExecutionTarget,
): boolean {
  const chat = getCurrentChatForVars(target);
  if (!chat?.GLGlobalVariables || !(key in chat.GLGlobalVariables)) {
    return false;
  }
  delete chat.GLGlobalVariables[key];
  return true;
}
