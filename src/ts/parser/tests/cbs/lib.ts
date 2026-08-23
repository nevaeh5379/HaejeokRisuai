import fc from "fast-check";
import { characterStore } from "src/ts/stores/domain/characterStore.svelte";
import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";

export const cbs = (op: string, ...args: string[]): string =>
  `{{${op}${args.length > 0 ? "::" : ""}${args.join("::")}}}`;

/**
 * Resets globalChatVariables and its default values,
 * as well as each character's all scriptstates and their default values.
 */
export const resetChatVariables = (): void => {
  for (const char of characterStore.characters) {
    for (const chat of char.chats ?? []) {
      chat.scriptstate = {};
    }
    char.defaultVariables = "";
  }

  settingsStore.state.globalChatVariables = {};
  settingsStore.state.templateDefaultVariables = "";
};

export const trimVarPrefix = (key: unknown): string => {
  if (typeof key !== "string") {
    return "null";
  }

  if (key.startsWith("$")) {
    return key.slice(1);
  }

  if (key.startsWith("toggle_")) {
    return key.slice("toggle_".length);
  }

  return "null";
};

/** No hashes, colons, curly braces, line breaks */
export const validCBSArgRegExp = /^[^#:{}\r\n]+$/;
/** {@link validCBSArgRegExp `validCBSArgRegExp`} */
export const validCBSArgProp = fc.oneof(
  fc.stringMatching(validCBSArgRegExp),
  fc.string({ unit: "grapheme" }).filter((s) => validCBSArgRegExp.test(s)),
);
