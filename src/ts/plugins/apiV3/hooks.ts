import type { OpenAIChat } from "@risuai/chat-core/types.ts";
import type {
  character,
  groupChat,
} from "@risuai/protocol/domain/legacy/character.ts";
import type { Chat as LegacyChat } from "@risuai/protocol/domain/legacy/chat.ts";

export type LegacyCharacter = character | groupChat;

export type PluginV2ProviderArgument = {
  prompt_chat: OpenAIChat[];
  frequency_penalty: number;
  min_p: number;
  presence_penalty: number;
  repetition_penalty: number;
  top_k: number;
  top_p: number;
  temperature: number;
  mode: string;
  max_tokens: number;
};

export type PluginV2ProviderOptions = {
  tokenizer?: string;
  tokenizerFunc?: (content: string) => number[] | Promise<number[]>;
};

export type EditFunction = (
  content: string,
) => string | null | undefined | Promise<string | null | undefined>;
export type ReplacerFunction = (
  content: OpenAIChat[],
  type: string,
) => OpenAIChat[] | Promise<OpenAIChat[]>;
export type ChatOutputListenerArg = {
  char: LegacyCharacter;
  chat: LegacyChat;
  characterIndex: number;
  chatIndex: number;
  messageIndex: number;
};
export type ChatOutputListener = (
  arg: ChatOutputListenerArg,
) => void | Promise<void>;

export const pluginHooks = {
  providers: new Map<
    string,
    (
      arg: PluginV2ProviderArgument,
      abortSignal?: AbortSignal,
    ) => Promise<{ success: boolean; content: string | ReadableStream<string> }>
  >(),
  providerOptions: new Map<string, PluginV2ProviderOptions>(),
  editdisplay: new Set<EditFunction>(),
  editoutput: new Set<EditFunction>(),
  editprocess: new Set<EditFunction>(),
  editinput: new Set<EditFunction>(),
  replacerbeforeRequest: new Set<ReplacerFunction>(),
  replacerafterRequest: new Set<
    (content: string, type: string) => string | Promise<string>
  >(),
  chatOutput: new Set<ChatOutputListener>(),
  unload: new Set<() => void | Promise<void>>(),
  loaded: false,
};

export type AfterRequestReplacer = (
  content: string,
  type: string,
) => string | Promise<string>;
export type ReplacerRegistration =
  | [name: "beforeRequest", callback: ReplacerFunction]
  | [name: "afterRequest", callback: AfterRequestReplacer];

export function addPluginReplacer(
  ...[name, callback]: ReplacerRegistration
): void {
  if (name === "beforeRequest") pluginHooks.replacerbeforeRequest.add(callback);
  else if (name === "afterRequest") {
    pluginHooks.replacerafterRequest.add(callback);
  } else throw new Error(`replacer handler named ${name} not found`);
}

export function removePluginReplacer(
  ...[name, callback]: ReplacerRegistration
): void {
  if (name === "beforeRequest") {
    pluginHooks.replacerbeforeRequest.delete(callback);
  } else if (name === "afterRequest") {
    pluginHooks.replacerafterRequest.delete(callback);
  } else throw new Error(`replacer handler named ${name} not found`);
}

export type ScriptMode = "display" | "output" | "input" | "process";
export function addScriptHandler(
  mode: ScriptMode,
  callback: EditFunction,
): void {
  const handlers = pluginHooks[`edit${mode}`];
  if (!handlers) throw new Error(`script handler named ${mode} not found`);
  handlers.add(callback);
}
export function removeScriptHandler(
  mode: ScriptMode,
  callback: EditFunction,
): void {
  const handlers = pluginHooks[`edit${mode}`];
  if (!handlers) throw new Error(`script handler named ${mode} not found`);
  handlers.delete(callback);
}
export function addChatListener(
  mode: "output",
  callback: ChatOutputListener,
): void {
  if (mode !== "output") {
    throw new Error(`chat listener mode ${mode} not found`);
  }
  pluginHooks.chatOutput.add(callback);
}
export function removeChatListener(
  mode: "output",
  callback: ChatOutputListener,
): void {
  if (mode !== "output") {
    throw new Error(`chat listener mode ${mode} not found`);
  }
  pluginHooks.chatOutput.delete(callback);
}
