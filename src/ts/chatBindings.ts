import type { Chat } from "./storage/database/schema";
import { characterStore } from "./stores/domain/characterStore.svelte";
import { presetStore } from "./stores/domain/presetStore.svelte";
import { settingsStore } from "./stores/domain/settingsStore.svelte";
import { getModuleToggles } from "./process/modules";
import { getGlobalChatVar, setGlobalChatVar } from "./parser/chatVar.svelte";
import { parseToggleSyntax } from "./util";
import { safeStructuredClone } from "./polyfill";

// Toggle binding is built on the chat's local global variables
// (`GLGlobalVariables` + `useLocallySetGlobalVariables`): a pinned chat keeps
// its own toggle values and every edit is stored on that chat.

function currentToggles() {
  const character = characterStore.currentCharacter;
  const characterToggle =
    character && character.type !== "group"
      ? (character.customModuleToggle ?? "")
      : "";
  return parseToggleSyntax(
    presetStore.state.customPromptTemplateToggle +
      "\n" +
      getModuleToggles() +
      "\n" +
      characterToggle,
  ).filter(
    (toggle) =>
      toggle.key &&
      toggle.type !== "group" &&
      toggle.type !== "groupEnd" &&
      toggle.type !== "caption" &&
      toggle.type !== "divider",
  );
}

/** Current value of every toggle in the active template; unset ones are omitted. */
export function snapshotToggleValues(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const toggle of currentToggles()) {
    const key = `toggle_${toggle.key}`;
    const value = getGlobalChatVar(key);
    if (value !== "null") values[key] = value;
  }
  return values;
}

/** Applies a saved set as a whole; toggles it does not name are turned off. */
export function applyToggleValues(values: Record<string, string>): void {
  for (const toggle of currentToggles()) {
    const key = `toggle_${toggle.key}`;
    const blank =
      toggle.type === "text" || toggle.type === "textarea" ? "" : "0";
    setGlobalChatVar(key, values[key] ?? blank);
  }
}

export function pinTogglesToChat(
  chat: Chat,
  values: Record<string, string> = snapshotToggleValues(),
): void {
  chat.GLGlobalVariables = { ...(chat.GLGlobalVariables ?? {}), ...values };
  chat.useLocallySetGlobalVariables = true;
}

export function unpinTogglesFromChat(chat: Chat): void {
  chat.useLocallySetGlobalVariables = false;
  if (!chat.GLGlobalVariables) return;
  chat.GLGlobalVariables = Object.fromEntries(
    Object.entries(chat.GLGlobalVariables).filter(
      ([key]) => !key.startsWith("toggle_"),
    ),
  );
}

/** Bindings a newly created chat starts with ("save as default"). */
export function newChatBindingDefaults(): Pick<
  Chat,
  "modelBinding" | "GLGlobalVariables" | "useLocallySetGlobalVariables"
> {
  const defaults: Pick<
    Chat,
    "modelBinding" | "GLGlobalVariables" | "useLocallySetGlobalVariables"
  > = {};
  const model = settingsStore.state.defaultModelBinding;
  if (model) defaults.modelBinding = safeStructuredClone(model);
  const toggles = settingsStore.state.defaultToggleValues;
  if (toggles) {
    defaults.GLGlobalVariables = safeStructuredClone(toggles);
    defaults.useLocallySetGlobalVariables = true;
  }
  return defaults;
}
