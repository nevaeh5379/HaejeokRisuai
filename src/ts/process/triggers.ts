import { alertToast } from "../alert";
import { language } from "../../lang";
import { NoteSource } from "../authorNote";
import { globalAuthorNoteStore } from "../stores/domain/globalAuthorNoteStore";
import { AuthorNoteError } from "../../../packages/protocol/src/authorNotes.ts";
import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import { parseChatML } from "../parser/chatML";
import { risuChatParser } from "../parser/parser.svelte";
import type { Chat, character } from "@risuai/protocol/domain/database.ts";

import { tokenize } from "../tokenizer";
import { getModuleTriggers } from "./modules";
import { get } from "svelte/store";
import {
  ReloadChatPointer,
  ReloadGUIPointer,
  selectedCharID,
} from "../stores.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { personaStore } from "../stores/domain/personaStore.svelte";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { processMultiCommand } from "./command";
import { parseKeyValue, sleep } from "../util";
import { alertError, alertInput, alertNormal, alertSelect } from "../alert";
import type { OpenAIChat } from "@risuai/chat-core/types.ts";
import { HypaProcesser } from "./memory/hypamemory";
import { requestChatData } from "./request/chatRequestOrchestrator";
import { generateAIImage } from "./stableDiff";
import { writeInlayImage } from "./files/inlays";
import { runScripted } from "./scriptings";
import { calcString } from "./infunctions";
import {
  getSelectedChatTarget,
  resolveChatTarget,
  type ChatExecutionTarget,
} from "../chatTarget";

import type {
  additonalSysPrompt,
  triggerEffectV2,
  triggerMode,
  triggerscript,
} from "../../../packages/protocol/domain/triggers.ts";
const safeSubset = [
  "v2GetAuthorNote",
  "v2SetVar",
  "v2If",
  "v2IfAdvanced",
  "v2Else",
  "v2EndIndent",
  "v2LoopNTimes",
  "v2BreakLoop",
  "v2ConsoleLog",
  "v2StopTrigger",
  "v2Random",
  "v2ExtractRegex",
  "v2RegexTest",
  "v2GetCharAt",
  "v2GetCharCount",
  "v2ToLowerCase",
  "v2ToUpperCase",
  "v2SetCharAt",
  "v2SplitString",
  "v2JoinArrayVar",
  "v2ConcatString",
  "v2MakeArrayVar",
  "v2GetArrayVarLength",
  "v2GetArrayVar",
  "v2SetArrayVar",
  "v2PushArrayVar",
  "v2PopArrayVar",
  "v2ShiftArrayVar",
  "v2UnshiftArrayVar",
  "v2SpliceArrayVar",
  "v2SliceArrayVar",
  "v2GetIndexOfValueInArrayVar",
  "v2RemoveIndexFromArrayVar",
  "v2Calculate",
  "v2Comment",
  "v2DeclareLocalVar",
];

export const displayAllowList = [
  "v2GetDisplayState",
  "v2SetDisplayState",
  ...safeSubset,
];

export const requestAllowList = [
  "v2GetRequestState",
  "v2SetRequestState",
  "v2GetRequestStateRole",
  "v2SetRequestStateRole",
  "v2GetRequestStateLength",
  ...safeSubset,
];

async function collectStreamingText(
  stream: ReadableStream<{ [key: string]: string }>,
): Promise<string> {
  const reader = stream.getReader();
  let lastChunk = "";

  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      const firstKey = Object.keys(value)[0];
      if (firstKey) {
        lastChunk = value[firstKey] ?? lastChunk;
      }
    }
    if (done) {
      break;
    }
  }

  return lastChunk;
}

export async function runTrigger(
  char: character,
  mode: triggerMode,
  arg: {
    chat: Chat;
    target?: ChatExecutionTarget;
    recursiveCount?: number;
    additonalSysPrompt?: additonalSysPrompt;
    stopSending?: boolean;
    manualName?: string;
    triggerId?: string;
    displayMode?: boolean;
    displayData?: string;
    tempVars?: Record<string, string>;
  },
) {
  if (!char) {
    return;
  }
  arg.recursiveCount ??= 0;
  char = arg.displayMode ? char : safeStructuredClone(char);
  let varChanged = false;
  let stopSending = arg.stopSending ?? false;
  const CharacterlowLevelAccess = char.lowLevelAccess ?? false;
  let sendAIprompt = false;
  let additonalSysPrompt: additonalSysPrompt = arg.additonalSysPrompt ?? {
    start: "",
    historyend: "",
    promptend: "",
  };
  const db = settingsStore.state;
  const target: ChatExecutionTarget | undefined =
    arg.target ??
    (char.chaId && arg.chat.id
      ? { characterId: char.chaId, chatId: arg.chat.id }
      : (getSelectedChatTarget() ?? undefined));
  const resolvedTarget = target ? resolveChatTarget(target) : null;
  const moduleRoom = resolvedTarget?.character ?? char;
  const getTargetChat = () =>
    target ? resolveChatTarget(target)?.chat : undefined;
  const triggers = (char.triggerscript || [])
    .map((v) => {
      if (typeof v === "string") {
        try {
          v = JSON.parse(v);
        } catch (e) {}
      }
      if (v && typeof v === "object") {
        v.lowLevelAccess = CharacterlowLevelAccess;
      }
      return v;
    })
    .filter((v) => v && typeof v === "object")
    .concat(getModuleTriggers(moduleRoom, undefined, resolvedTarget?.chat));
  const getStoredTriggerCharacter = () => {
    const stored = characterStore.characters.find(
      (candidate) => candidate?.chaId === char.chaId,
    );
    return stored?.type === "group" ? undefined : stored;
  };
  const persistGlobalLore = () => {
    const stored = getStoredTriggerCharacter();
    if (!stored) return;
    stored.globalLore = safeStructuredClone(char.globalLore ?? []);
    if (stored.chaId) characterStore.markCharacterDirty(stored.chaId);
  };
  const persistCharacterDescription = () => {
    const stored = getStoredTriggerCharacter();
    if (!stored) return;
    stored.desc = char.desc;
    if (stored.chaId) characterStore.markCharacterDirty(stored.chaId);
  };
  const persistReplaceGlobalNote = () => {
    const stored = getStoredTriggerCharacter();
    if (!stored) return;
    stored.replaceGlobalNote = char.replaceGlobalNote;
    if (stored.chaId) characterStore.markCharacterDirty(stored.chaId);
  };
  const persistTargetAuthorNote = (value: string) => {
    const targetChat = getTargetChat();
    if (!targetChat) return;
    targetChat.note = value;
    if (targetChat.id) characterStore.markChatDirty(targetChat.id);
  };
  const defaultVariables = parseKeyValue(char.defaultVariables).concat(
    parseKeyValue(presetStore.state.templateDefaultVariables),
  );
  let chat = arg.displayMode
    ? arg.chat
    : safeStructuredClone(arg.chat ?? char.chats[char.chatPage]);

  if (!triggers || triggers.length === 0) {
    return null;
  }

  const noteSource = NoteSource.get(chat);
  const sharedNote =
    noteSource.mode === "global"
      ? await globalAuthorNoteStore.get(noteSource.noteId)
      : null;
  let authorNoteContent = chat.note ?? "";
  if (noteSource.mode === "global") {
    try {
      authorNoteContent = sharedNote ? await sharedNote.getContent() : "";
    } catch (error) {
      if (error instanceof AuthorNoteError && error.code === "missing")
        authorNoteContent = "";
      else throw error;
    }
  }

  let tempVars: Record<string, string> = arg.tempVars ?? {};

  let localVarScopes: Record<number, Record<string, string>>[] = [{}];
  let currentIndent = 0;

  function getLocalVar(key: string): string | null {
    if (!localVarScopes || localVarScopes.length === 0) {
      return null;
    }
    const currentScope = localVarScopes[localVarScopes.length - 1];
    if (!currentScope) {
      return null;
    }
    for (let indent = currentIndent; indent >= 0; indent--) {
      if (currentScope[indent] && currentScope[indent][key] !== undefined) {
        const value = currentScope[indent][key];
        return value;
      }
    }
    return null;
  }

  function setLocalVar(key: string, value: string, indent: number): boolean {
    if (!localVarScopes || localVarScopes.length === 0) {
      localVarScopes = [{}];
    }
    const currentScope = localVarScopes[localVarScopes.length - 1];
    if (!currentScope) {
      return false;
    }

    const finalValue = value === null || value === undefined ? "null" : value;

    let foundIndent = -1;
    for (let i = indent; i >= 0; i--) {
      if (currentScope[i] && currentScope[i][key] !== undefined) {
        foundIndent = i;
        break;
      }
    }

    const targetIndent = foundIndent !== -1 ? foundIndent : indent;

    if (!currentScope[targetIndent]) {
      currentScope[targetIndent] = {};
    }

    if (currentScope[targetIndent][key] === finalValue) {
      return false;
    }

    currentScope[targetIndent][key] = finalValue;
    return true;
  }

  function declareLocalVar(key: string, value: string, indent: number) {
    setLocalVar(key, value, indent);
  }

  function clearLocalVarsAtIndent(indent: number) {
    if (!localVarScopes || localVarScopes.length === 0) {
      return;
    }
    const currentScope = localVarScopes[localVarScopes.length - 1];
    if (!currentScope) {
      return;
    }
    const indentsToDelete: string[] = [];
    for (const scopeIndent in currentScope) {
      if (Number(scopeIndent) >= indent) {
        indentsToDelete.push(scopeIndent);
      }
    }
    indentsToDelete.forEach((indentKey) => {
      delete currentScope[indentKey];
    });
  }

  function getVar(key: string) {
    const localVar = getLocalVar(key);
    if (localVar !== null) {
      return localVar;
    }

    const state = chat.scriptstate?.["$" + key];
    if (state === undefined || state === null) {
      const findResult = defaultVariables.find((f) => {
        return f[0] === key;
      });
      if (findResult) {
        return findResult[1];
      }
      if (arg.displayMode) {
        return tempVars[key] ?? "null";
      }
      return "null";
    }
    return state.toString();
  }

  const parseTriggerText = (
    text: string,
    parserArg: Parameters<typeof risuChatParser>[1] = {},
  ) =>
    risuChatParser(text, {
      ...parserArg,
      chatTarget: target,
      authorNoteContent,
      triggerId: arg.triggerId,
    });

  function setVar(key: string, value: string): boolean {
    if (arg.displayMode) {
      if (tempVars[key] === value) {
        return false;
      }
      tempVars[key] = value;
      return true;
    }

    const localVar = getLocalVar(key);
    if (localVar !== null) {
      return setLocalVar(key, value, currentIndent);
    }

    chat.scriptstate ??= {};
    const stateKey = "$" + key;
    if (chat.scriptstate[stateKey] === value) {
      return false;
    }

    varChanged = true;
    chat.scriptstate[stateKey] = value;
    return true;
  }

  for (const trigger of triggers) {
    let tempVars: Record<string, number> = {};

    if (
      trigger.effect[0]?.type === "triggercode" ||
      trigger.effect[0]?.type === "triggerlua"
    ) {
      //
    } else if (arg.manualName) {
      if (trigger.comment !== arg.manualName) {
        continue;
      }
    } else if (mode !== trigger.type) {
      continue;
    }

    let pass = true;
    for (const condition of trigger.conditions) {
      if (
        condition.type === "var" ||
        condition.type === "chatindex" ||
        condition.type === "value"
      ) {
        let varValue =
          condition.type === "var"
            ? (getVar(condition.var) ?? "null")
            : condition.type === "chatindex"
              ? chat.message.length.toString()
              : condition.type === "value"
                ? condition.var
                : null;

        if (varValue === undefined || varValue === null) {
          pass = false;
          break;
        } else {
          const conditionValue = parseTriggerText(condition.value, {
            chara: char,
          });
          varValue = parseTriggerText(varValue, { chara: char });
          switch (condition.operator) {
            case "true": {
              if (varValue !== "true" && varValue !== "1") {
                pass = false;
              }
              break;
            }
            case "=":
              if (varValue !== conditionValue) {
                pass = false;
              }
              break;
            case "!=":
              if (varValue === conditionValue) {
                pass = false;
              }
              break;
            case ">":
              if (Number(varValue) <= Number(conditionValue)) {
                pass = false;
              }
              break;
            case "<":
              if (Number(varValue) >= Number(conditionValue)) {
                pass = false;
              }
              break;
            case ">=":
              if (Number(varValue) < Number(conditionValue)) {
                pass = false;
              }
              break;
            case "<=":
              if (Number(varValue) > Number(conditionValue)) {
                pass = false;
              }
              break;
            case "null":
              if (varValue !== "null") {
                pass = false;
              }
              break;
          }
        }
      } else if (condition.type === "exists") {
        const conditionValue = parseTriggerText(condition.value, {
          chara: char,
        });
        const val = parseTriggerText(conditionValue, { chara: char });
        let da = chat.message
          .slice(0 - condition.depth)
          .map((v) => v.data)
          .join(" ");
        if (condition.type2 === "strict") {
          pass = da.split(" ").includes(val);
        } else if (condition.type2 === "loose") {
          pass = da.toLowerCase().includes(val.toLowerCase());
        } else if (condition.type2 === "regex") {
          pass = new RegExp(val).test(da);
        }
      }
      if (!pass) {
        break;
      }
    }
    if (!pass) {
      continue;
    }

    for (let index = 0; index < trigger.effect.length; index++) {
      const effect = trigger.effect[index];
      if (mode === "display" && !displayAllowList.includes(effect.type)) {
        continue;
      }
      if (mode === "request" && !requestAllowList.includes(effect.type)) {
        continue;
      }

      if (
        effect &&
        "indent" in effect &&
        typeof effect.indent === "number" &&
        effect.indent >= 0
      ) {
        currentIndent = effect.indent;
      } else if (!effect || !("indent" in effect)) {
        currentIndent = 0;
      }

      switch (effect.type) {
        case "setvar": {
          const effectValue = parseTriggerText(effect.value, { chara: char });
          const varKey = parseTriggerText(effect.var, { chara: char });
          let originalVar = Number(getVar(varKey));
          if (Number.isNaN(originalVar)) {
            originalVar = 0;
          }
          let resultValue = "";
          switch (effect.operator) {
            case "=": {
              resultValue = effectValue;
              break;
            }
            case "+=": {
              resultValue = (originalVar + Number(effectValue)).toString();
              break;
            }
            case "-=": {
              resultValue = (originalVar - Number(effectValue)).toString();
              break;
            }
            case "*=": {
              resultValue = (originalVar * Number(effectValue)).toString();
              break;
            }
            case "/=": {
              resultValue = (originalVar / Number(effectValue)).toString();
              break;
            }
          }
          setVar(varKey, resultValue);
          break;
        }
        case "systemprompt": {
          const effectValue = parseTriggerText(effect.value, { chara: char });
          additonalSysPrompt[effect.location] += effectValue + "\n\n";
          break;
        }
        case "impersonate": {
          const effectValue = parseTriggerText(effect.value, { chara: char });
          if (effect.role === "user") {
            chat.message.push({ role: "user", data: effectValue });
          } else if (effect.role === "char") {
            chat.message.push({ role: "char", data: effectValue });
          }
          break;
        }
        case "command": {
          const effectValue = parseTriggerText(effect.value, { chara: char });
          await processMultiCommand(effectValue);
          break;
        }
        case "stop":
        case "v2StopPromptSending": {
          stopSending = true;
          break;
        }
        case "runtrigger": {
          if (arg.recursiveCount < 10 || trigger.lowLevelAccess) {
            arg.recursiveCount++;
            const r = await runTrigger(char, "manual", {
              chat,
              target,
              recursiveCount: arg.recursiveCount,
              additonalSysPrompt,
              stopSending,
              manualName: effect.value,
              triggerId: arg.triggerId,
            });
            if (r) {
              additonalSysPrompt = r.additonalSysPrompt;
              chat = r.chat;
              stopSending = r.stopSending;
            }
          }
          break;
        }
        case "cutchat": {
          const start = Number(parseTriggerText(effect.start, { chara: char }));
          const end = Number(parseTriggerText(effect.end, { chara: char }));
          chat.message = chat.message.slice(start, end);
          break;
        }
        case "modifychat": {
          const index = Number(parseTriggerText(effect.index, { chara: char }));
          const value = parseTriggerText(effect.value, { chara: char });
          if (chat.message[index]) {
            chat.message[index].data = value;
          }
          break;
        }

        // low level access only
        case "showAlert": {
          if (!trigger.lowLevelAccess) {
            break;
          }

          if (arg.displayMode) {
            return;
          }

          const effectValue = parseTriggerText(effect.value, { chara: char });
          const inputVar = parseTriggerText(effect.inputVar, { chara: char });

          switch (effect.alertType) {
            case "normal": {
              alertNormal(effectValue);
              break;
            }
            case "error": {
              alertError(effectValue);
              break;
            }
            case "input": {
              const val = await alertInput(effectValue);
              setVar(inputVar, val);
              break;
            }
            case "select": {
              const val = await alertSelect(effectValue.split("§"));
              setVar(inputVar, val);
            }
          }
          break;
        }

        case "sendAIprompt": {
          if (!trigger.lowLevelAccess) {
            break;
          }
          sendAIprompt = true;
          break;
        }

        case "runLLM": {
          if (!trigger.lowLevelAccess) {
            break;
          }
          const effectValue = parseTriggerText(effect.value, { chara: char });
          const varName = effect.inputVar;
          let promptbody: OpenAIChat[] = parseChatML(effectValue);
          if (!promptbody) {
            promptbody = [{ role: "user", content: effectValue }];
          }
          const result = await requestChatData(
            {
              formated: promptbody,
              bias: {},
              useStreaming: false,
              noMultiGen: true,
              currentChar: char,
              triggerTarget: target,
            },
            "model",
          );

          if (
            result.type === "fail" ||
            result.type === "streaming" ||
            result.type === "multiline"
          ) {
            setVar(varName, "Error: " + result.result);
          } else {
            setVar(varName, result.result);
          }

          break;
        }

        case "runAxLLM": {
          if (!trigger.lowLevelAccess) {
            break;
          }
          const effectValue = parseTriggerText(effect.value, { chara: char });
          const varName = effect.inputVar;
          let promptbody: OpenAIChat[] = parseChatML(effectValue);
          if (!promptbody) {
            promptbody = [{ role: "user", content: effectValue }];
          }
          const result = await requestChatData(
            {
              formated: promptbody,
              bias: {},
              useStreaming: false,
              noMultiGen: true,
              currentChar: char,
              triggerTarget: target,
              staticModel: settingsStore.state.enableModuleSubModel
                ? trigger.subModel
                : undefined,
              sourceModuleId: trigger.sourceModuleId,
              moduleSandboxGroupId: trigger.sandboxGroupId,
            },
            "submodel",
          );

          if (
            result.type === "fail" ||
            result.type === "streaming" ||
            result.type === "multiline"
          ) {
            setVar(varName, "Error: " + result.result);
          } else {
            setVar(varName, result.result);
          }

          break;
        }

        case "checkSimilarity": {
          if (!trigger.lowLevelAccess) {
            break;
          }

          const processer = new HypaProcesser();
          const effectValue = parseTriggerText(effect.value, { chara: char });
          const source = parseTriggerText(effect.source, { chara: char });
          await processer.addText(effectValue.split("§"));
          const val = await processer.similaritySearch(source);
          setVar(effect.inputVar, val.join("§"));
          break;
        }

        case "extractRegex": {
          if (!trigger.lowLevelAccess) {
            break;
          }

          const effectValue = parseTriggerText(effect.value, { chara: char });
          const regex = new RegExp(effect.regex, effect.flags);
          const regexResult = regex.exec(effectValue);
          const result = effect.result
            .replace(/\$[0-9]+/g, (match) => {
              const index = Number(match.slice(1));
              return regexResult[index];
            })
            .replace(/\$&/g, regexResult[0])
            .replace(/\$\$/g, "$");

          setVar(effect.inputVar, result);
          break;
        }

        case "runImgGen": {
          if (!trigger.lowLevelAccess) {
            break;
          }

          const effectValue = parseTriggerText(effect.value, { chara: char });
          const negValue = parseTriggerText(effect.negValue, { chara: char });
          const gen = await generateAIImage(
            effectValue,
            char,
            negValue,
            "inlay",
          );
          if (!gen) {
            setVar(effect.inputVar, "Error: Image generation failed");
            break;
          }
          const imgHTML = new Image();
          imgHTML.src = gen;
          const inlay = await writeInlayImage(imgHTML);
          const res = `{{inlay::${inlay}}}`;
          setVar(effect.inputVar, res);
          break;
        }

        case "triggerlua": {
          const sandboxOwners = trigger.sandboxOwnerModuleIds?.length
            ? trigger.sandboxOwnerModuleIds
            : [undefined];
          for (const sandboxOwnerModuleId of sandboxOwners) {
            const triggerCodeResult = await runScripted(effect.code, {
              lowLevelAccess: trigger.lowLevelAccess,
              mode: mode === "manual" ? arg.manualName : mode,
              setVar: setVar,
              getVar: getVar,
              char: char,
              chat: chat,
              chatTarget: target,
              triggerId: arg.triggerId,
              subModel: settingsStore.state.enableModuleSubModel
                ? trigger.subModel
                : undefined,
              sourceModuleId: trigger.sourceModuleId,
              sandboxOwnerModuleId,
              sandboxGroupId: trigger.sandboxGroupId,
              sandboxInstanceId: trigger.sandboxInstanceId,
              sandboxModuleIds: trigger.sandboxModuleIds,
            });

            if (triggerCodeResult.stopSending) {
              stopSending = true;
            }
            chat = triggerCodeResult.chat;
          }
          break;
        }

        //V2 triggers
        case "v2Header": {
          //Header for V2 triggers to identify the start of a new trigger
          break;
        }
        case "v2SetVar": {
          const effectValue =
            effect.valueType === "value"
              ? parseTriggerText(effect.value, { chara: char })
              : getVar(parseTriggerText(effect.value, { chara: char }));
          const varKey = parseTriggerText(effect.var, { chara: char });
          let originalVar = Number(getVar(varKey));
          if (Number.isNaN(originalVar)) {
            originalVar = 0;
          }
          let resultValue = "";
          switch (effect.operator) {
            case "=": {
              resultValue = effectValue;
              break;
            }
            case "+=": {
              resultValue = (originalVar + Number(effectValue)).toString();
              break;
            }
            case "-=": {
              resultValue = (originalVar - Number(effectValue)).toString();
              break;
            }
            case "*=": {
              resultValue = (originalVar * Number(effectValue)).toString();
              break;
            }
            case "/=": {
              resultValue = (originalVar / Number(effectValue)).toString();
              break;
            }
            case "%=": {
              resultValue = (originalVar % Number(effectValue)).toString();
              break;
            }
          }
          setVar(varKey, resultValue);
          break;
        }
        case "v2DeclareLocalVar": {
          const effectValue =
            effect.valueType === "value"
              ? parseTriggerText(effect.value, { chara: char })
              : getVar(parseTriggerText(effect.value, { chara: char }));
          const varKey = parseTriggerText(effect.var, { chara: char });
          const finalValue =
            effectValue === null || effectValue === undefined
              ? "null"
              : effectValue;
          declareLocalVar(varKey, finalValue, effect.indent);
          break;
        }
        case "v2If":
        case "v2IfAdvanced": {
          const sourceValue =
            effect.type === "v2If" || effect.sourceType === "var"
              ? getVar(parseTriggerText(effect.source, { chara: char }))
              : parseTriggerText(effect.source, { chara: char });
          const targetValue =
            effect.targetType === "value"
              ? parseTriggerText(effect.target, { chara: char })
              : getVar(parseTriggerText(effect.target, { chara: char }));
          let pass = false;
          switch (effect.condition) {
            case "=": {
              if (!isNaN(Number(sourceValue)) && !isNaN(Number(targetValue))) {
                //to check like 1.0 = 1
                pass = Number(sourceValue) === Number(targetValue);
              } else {
                pass = sourceValue === targetValue;
              }
              break;
            }
            case "!=": {
              if (!isNaN(Number(sourceValue)) && !isNaN(Number(targetValue))) {
                //to check like 1.0 = 1
                pass = Number(sourceValue) !== Number(targetValue);
              } else {
                pass = sourceValue !== targetValue;
              }
              break;
            }
            case ">": {
              pass = Number(sourceValue) > Number(targetValue);
              break;
            }
            case "<": {
              pass = Number(sourceValue) < Number(targetValue);
              break;
            }
            case ">=": {
              pass = Number(sourceValue) >= Number(targetValue);
              break;
            }
            case "<=": {
              pass = Number(sourceValue) <= Number(targetValue);
              break;
            }
            case "∈": {
              try {
                pass = JSON.parse(targetValue).includes(sourceValue);
              } catch (error) {
                pass = false;
              }
              break;
            }
            case "∋": {
              try {
                pass = JSON.parse(sourceValue).includes(targetValue);
              } catch (error) {
                pass = false;
              }
              break;
            }
            case "∉": {
              try {
                pass = !JSON.parse(targetValue).includes(sourceValue);
              } catch (error) {
                pass = true;
              }
              break;
            }
            case "∌": {
              try {
                pass = !JSON.parse(sourceValue).includes(targetValue);
              } catch (error) {
                pass = true;
              }
              break;
            }
            case "≒": {
              const num1 = Number(sourceValue);
              const num2 = Number(targetValue);
              if (Number.isNaN(num1) || Number.isNaN(num2)) {
                pass =
                  sourceValue.toLocaleLowerCase().replace(/ /g, "") ===
                  targetValue.toLocaleLowerCase().replace(/ /g, "");
              } else {
                pass = Math.abs(num1 - num2) < 0.0001;
              }
              break;
            }
            case "≡": {
              if (targetValue === "true") {
                pass = sourceValue === "true" || sourceValue === "1";
              } else if (targetValue === "false") {
                pass = !(sourceValue === "true" || sourceValue === "1");
              } else {
                pass = sourceValue === targetValue;
              }
            }
          }

          if (!pass) {
            let indent = effect.indent + 1;
            for (; index < trigger.effect.length; index++) {
              const ef = trigger.effect[index] as triggerEffectV2;
              if (ef.type === "v2EndIndent" && indent === ef.indent) {
                const nextEf = trigger.effect[index + 1] as triggerEffectV2;
                indent--;
                if (nextEf?.type === "v2Else" && nextEf?.indent === indent) {
                  index++;
                }

                break;
              }
            }
          }
          break;
        }
        case "v2Else": {
          //since if handles the else if the if is false, we can skip the else
          const indent = effect.indent + 1;
          for (; index < trigger.effect.length; index++) {
            const ef = trigger.effect[index] as triggerEffectV2;
            if (ef.type === "v2EndIndent" && indent === ef.indent) {
              break;
            }
          }
          break;
        }
        case "v2EndIndent": {
          if (effect.endOfLoop) {
            const indent = effect.indent - 1;
            const originalIndex = index;
            for (; index >= 0; index--) {
              const ef = trigger.effect[index] as triggerEffectV2;
              if (
                (ef.type === "v2Loop" || ef.type === "v2LoopNTimes") &&
                indent === ef.indent
              ) {
                if (ef.type === "v2LoopNTimes") {
                  let value =
                    ef.valueType === "value"
                      ? parseTriggerText(ef.value, { chara: char })
                      : getVar(parseTriggerText(ef.value, { chara: char }));
                  let valueNum = Number(value);
                  if (Number.isNaN(valueNum)) {
                    valueNum = 0;
                  }
                  tempVars[index + "LoopNTimes"] =
                    (tempVars[index + "LoopNTimes"] ?? 0) + 1;
                  if (tempVars[index + "LoopNTimes"] >= valueNum) {
                    index = originalIndex;
                  } else {
                    break;
                  }
                }

                break;
              }
            }

            //this is for preventing lagging
            tempVars["loopTimes"] = (tempVars["loopTimes"] ?? 0) + 1;
            if (tempVars["loopTimes"] > 100) {
              await sleep(1);
              tempVars["loopTimes"] = 0;
            }
          }

          clearLocalVarsAtIndent(effect.indent);

          break;
        }
        case "v2Loop":
        case "v2LoopNTimes": {
          //Looping is handled by the v2EndIndent
          break;
        }
        case "v2BreakLoop": {
          for (; index < trigger.effect.length; index++) {
            const ef = trigger.effect[index] as triggerEffectV2;
            if (ef.type === "v2EndIndent" && ef.endOfLoop) {
              break;
            }
          }
          break;
        }
        case "v2RunTrigger": {
          if (arg.recursiveCount < 10 || trigger.lowLevelAccess) {
            arg.recursiveCount++;
            const r = await runTrigger(char, "manual", {
              chat,
              target,
              recursiveCount: arg.recursiveCount,
              additonalSysPrompt,
              stopSending,
              manualName: effect.target,
            });
            if (r) {
              additonalSysPrompt = r.additonalSysPrompt;
              chat = r.chat;
              stopSending = r.stopSending;
            }
          }
          break;
        }
        case "v2ConsoleLog": {
          const sourceValue =
            effect.sourceType === "value"
              ? parseTriggerText(effect.source, { chara: char })
              : getVar(parseTriggerText(effect.source, { chara: char }));
          console.log(sourceValue);
          break;
        }
        case "v2StopTrigger": {
          index = trigger.effect.length;
          break;
        }
        case "v2CutChat": {
          let start =
            effect.startType === "value"
              ? Number(parseTriggerText(effect.start, { chara: char }))
              : Number(getVar(parseTriggerText(effect.start, { chara: char })));
          let end =
            effect.endType === "value"
              ? Number(parseTriggerText(effect.end, { chara: char }))
              : Number(getVar(parseTriggerText(effect.end, { chara: char })));
          if (isNaN(start)) {
            start = 0;
          }
          if (isNaN(end)) {
            end = chat.message.length;
          }

          chat.message = chat.message.slice(start, end);
          break;
        }
        case "v2ModifyChat": {
          let index =
            effect.indexType === "value"
              ? Number(parseTriggerText(effect.index, { chara: char }))
              : Number(getVar(parseTriggerText(effect.index, { chara: char })));
          let value =
            effect.valueType === "value"
              ? parseTriggerText(effect.value, { chara: char })
              : getVar(parseTriggerText(effect.value, { chara: char }));
          if (chat.message[index]) {
            chat.message[index].data = value;
          }
          break;
        }
        case "v2SystemPrompt": {
          let value =
            effect.valueType === "value"
              ? parseTriggerText(effect.value, { chara: char })
              : getVar(parseTriggerText(effect.value, { chara: char }));
          additonalSysPrompt[effect.location] += value + "\n\n";
          break;
        }
        case "v2Impersonate": {
          let value =
            effect.valueType === "value"
              ? parseTriggerText(effect.value, { chara: char })
              : getVar(parseTriggerText(effect.value, { chara: char }));
          if (effect.role === "user") {
            chat.message.push({ role: "user", data: value });
          } else if (effect.role === "char") {
            chat.message.push({ role: "char", data: value });
          }
          break;
        }
        case "v2Command": {
          let value =
            effect.valueType === "value"
              ? parseTriggerText(effect.value, { chara: char })
              : getVar(parseTriggerText(effect.value, { chara: char }));
          await processMultiCommand(value);
          break;
        }
        case "v2SendAIprompt": {
          if (!trigger.lowLevelAccess) {
            break;
          }
          sendAIprompt = true;
          break;
        }
        case "v2ImgGen": {
          if (!trigger.lowLevelAccess) {
            break;
          }
          let value =
            effect.valueType === "value"
              ? parseTriggerText(effect.value, { chara: char })
              : getVar(parseTriggerText(effect.value, { chara: char }));
          let negValue =
            effect.negValueType === "value"
              ? parseTriggerText(effect.negValue, { chara: char })
              : getVar(parseTriggerText(effect.negValue, { chara: char }));
          let gen = await generateAIImage(value, char, negValue, "inlay");
          if (!gen) {
            setVar(parseTriggerText(effect.outputVar, { chara: char }), "null");
            break;
          }
          let imgHTML = new Image();
          imgHTML.src = gen;
          let inlay = await writeInlayImage(imgHTML);
          let res = `{{inlay::${inlay}}}`;
          setVar(parseTriggerText(effect.outputVar, { chara: char }), res);
          break;
        }
        case "v2CheckSimilarity": {
          if (!trigger.lowLevelAccess) {
            break;
          }
          let source =
            effect.sourceType === "value"
              ? parseTriggerText(effect.source, { chara: char })
              : getVar(parseTriggerText(effect.source, { chara: char }));
          let value =
            effect.valueType === "value"
              ? parseTriggerText(effect.value, { chara: char })
              : getVar(parseTriggerText(effect.value, { chara: char }));
          let processer = new HypaProcesser();
          await processer.addText(value.split("§"));
          let val = await processer.similaritySearch(source);
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            val.join("§"),
          );
          break;
        }
        case "v2RunLLM": {
          if (!trigger.lowLevelAccess) {
            break;
          }
          let value =
            effect.valueType === "value"
              ? parseTriggerText(effect.value, { chara: char })
              : getVar(parseTriggerText(effect.value, { chara: char }));
          let promptbody = parseChatML(value);
          if (!promptbody) {
            promptbody = [{ role: "user", content: value }];
          }
          let result = await requestChatData(
            {
              formated: promptbody,
              bias: {},
              useStreaming: effect.streaming ?? false,
              noMultiGen: true,
              currentChar: char,
              triggerTarget: target,
              staticModel:
                effect.model === "submodel" &&
                settingsStore.state.enableModuleSubModel
                  ? trigger.subModel
                  : undefined,
              sourceModuleId: trigger.sourceModuleId,
              moduleSandboxGroupId: trigger.sandboxGroupId,
            },
            effect.model,
          );

          if (result.type === "fail" || result.type === "multiline") {
            setVar(parseTriggerText(effect.outputVar, { chara: char }), "null");
          } else if (result.type === "streaming") {
            const text = await collectStreamingText(result.result);
            setVar(parseTriggerText(effect.outputVar, { chara: char }), text);
          } else {
            setVar(
              parseTriggerText(effect.outputVar, { chara: char }),
              result.result,
            );
          }
          break;
        }
        case "v2ShowAlert": {
          if (arg.displayMode) {
            return;
          }
          let value =
            effect.valueType === "value"
              ? parseTriggerText(effect.value, { chara: char })
              : getVar(parseTriggerText(effect.value, { chara: char }));
          alertNormal(value);
          break;
        }
        case "v2ExtractRegex": {
          let value =
            effect.valueType === "value"
              ? parseTriggerText(effect.value, { chara: char })
              : getVar(parseTriggerText(effect.value, { chara: char }));
          let regexValue =
            effect.regexType === "value"
              ? parseTriggerText(effect.regex, { chara: char })
              : getVar(parseTriggerText(effect.regex, { chara: char }));
          let flagsValue =
            effect.flagsType === "value"
              ? parseTriggerText(effect.flags, { chara: char })
              : getVar(parseTriggerText(effect.flags, { chara: char }));
          let regex = new RegExp(regexValue, flagsValue);
          let regexResult = regex.exec(value);
          let resultValue =
            effect.resultType === "value"
              ? parseTriggerText(effect.result, { chara: char })
              : getVar(parseTriggerText(effect.result, { chara: char }));

          let result = "";
          if (regexResult !== null) {
            result = resultValue
              .replace(/\$[0-9]+/g, (match) => {
                let index = Number(match.slice(1));
                return regexResult[index] || "";
              })
              .replace(/\$&/g, regexResult[0] || "")
              .replace(/\$\$/g, "$");
          } else {
            result = resultValue
              .replace(/\$[0-9]+/g, "")
              .replace(/\$&/g, "")
              .replace(/\$\$/g, "$");
          }

          setVar(parseTriggerText(effect.outputVar, { chara: char }), result);
          break;
        }
        case "v2GetLastMessage": {
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            chat.message[chat.message.length - 1]?.data ?? "null",
          );
          break;
        }
        case "v2GetMessageAtIndex": {
          let index =
            effect.indexType === "value"
              ? Number(parseTriggerText(effect.index, { chara: char }))
              : Number(getVar(parseTriggerText(effect.index, { chara: char })));
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            chat.message[index]?.data ?? "null",
          );
          break;
        }
        case "v2GetMessageCount": {
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            chat.message.length.toString(),
          );
          break;
        }
        case "v2ModifyLorebook": {
          char.globalLore = char.globalLore ?? [];
          const target =
            effect.targetType === "value"
              ? parseTriggerText(effect.target, { chara: char })
              : getVar(parseTriggerText(effect.target, { chara: char }));
          const value =
            effect.valueType === "value"
              ? parseTriggerText(effect.value, { chara: char })
              : getVar(parseTriggerText(effect.value, { chara: char }));

          const index = char.globalLore.findIndex((v) => v[0] === target);
          if (index !== -1) {
            char.globalLore[index][1] = value;
          }

          persistGlobalLore();
          break;
        }
        case "v2GetLorebook": {
          char.globalLore = char.globalLore ?? [];
          const target =
            effect.targetType === "value"
              ? parseTriggerText(effect.target, { chara: char })
              : getVar(parseTriggerText(effect.target, { chara: char }));
          const index = char.globalLore.findIndex((v) => v[0] === target);
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            index === -1 ? "null" : char.globalLore[index][1],
          );
          break;
        }
        case "v2GetLorebookCount": {
          char.globalLore = char.globalLore ?? [];
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            char.globalLore.length.toString(),
          );
          break;
        }
        case "v2GetLorebookEntry": {
          char.globalLore = char.globalLore ?? [];
          let index =
            effect.indexType === "value"
              ? Number(parseTriggerText(effect.index, { chara: char }))
              : Number(getVar(parseTriggerText(effect.index, { chara: char })));
          if (Number.isNaN(index)) {
            index = 0;
          }
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            char.globalLore[index]?.[1] ?? "null",
          );
          break;
        }
        case "v2SetLorebookActivation": {
          char.globalLore = char.globalLore ?? [];
          let index =
            effect.indexType === "value"
              ? Number(parseTriggerText(effect.index, { chara: char }))
              : Number(getVar(parseTriggerText(effect.index, { chara: char })));
          let value = effect.value;
          char.globalLore[index][2] = value;

          persistGlobalLore();

          break;
        }
        case "v2GetLorebookIndexViaName": {
          char.globalLore = char.globalLore ?? [];
          let name =
            effect.nameType === "value"
              ? parseTriggerText(effect.name, { chara: char })
              : getVar(parseTriggerText(effect.name, { chara: char }));
          let index = char.globalLore.findIndex((v) => v[0] === name);
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            index.toString(),
          );
          break;
        }
        case "v2Random": {
          let min =
            effect.minType === "value"
              ? Number(parseTriggerText(effect.min, { chara: char }))
              : Number(getVar(parseTriggerText(effect.min, { chara: char })));
          let max =
            effect.maxType === "value"
              ? Number(parseTriggerText(effect.max, { chara: char }))
              : Number(getVar(parseTriggerText(effect.max, { chara: char })));

          let output = Math.floor(Math.random() * (max - min + 1) + min);
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            output.toString(),
          );
          break;
        }
        case "v2GetCharAt": {
          let source =
            effect.sourceType === "value"
              ? parseTriggerText(effect.source, { chara: char })
              : getVar(parseTriggerText(effect.source, { chara: char }));
          let index =
            effect.indexType === "value"
              ? Number(parseTriggerText(effect.index, { chara: char }))
              : Number(getVar(parseTriggerText(effect.index, { chara: char })));
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            source[index] ?? "null",
          );
          break;
        }
        case "v2GetCharCount": {
          let source =
            effect.sourceType === "value"
              ? parseTriggerText(effect.source, { chara: char })
              : getVar(parseTriggerText(effect.source, { chara: char }));
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            source.length.toString(),
          );
          break;
        }
        case "v2ToLowerCase": {
          let source =
            effect.sourceType === "value"
              ? parseTriggerText(effect.source, { chara: char })
              : getVar(parseTriggerText(effect.source, { chara: char }));
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            source.toLowerCase(),
          );
          break;
        }
        case "v2ToUpperCase": {
          let source =
            effect.sourceType === "value"
              ? parseTriggerText(effect.source, { chara: char })
              : getVar(parseTriggerText(effect.source, { chara: char }));
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            source.toUpperCase(),
          );
          break;
        }
        case "v2SetCharAt": {
          let source =
            effect.sourceType === "value"
              ? parseTriggerText(effect.source, { chara: char })
              : getVar(parseTriggerText(effect.source, { chara: char }));
          let index =
            effect.indexType === "value"
              ? Number(parseTriggerText(effect.index, { chara: char }))
              : Number(getVar(parseTriggerText(effect.index, { chara: char })));
          let value =
            effect.valueType === "value"
              ? parseTriggerText(effect.value, { chara: char })
              : getVar(parseTriggerText(effect.value, { chara: char }));
          const source2 = [...source];
          source2[index] = value;
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            source2.join(""),
          );
          break;
        }
        case "v2SplitString": {
          let source =
            effect.sourceType === "value"
              ? parseTriggerText(effect.source, { chara: char })
              : getVar(parseTriggerText(effect.source, { chara: char }));
          let delimiter: string;

          if (effect.delimiterType === "value") {
            delimiter = parseTriggerText(effect.delimiter, { chara: char });
          } else if (effect.delimiterType === "var") {
            delimiter = getVar(
              parseTriggerText(effect.delimiter, { chara: char }),
            );
          } else {
            delimiter = parseTriggerText(effect.delimiter, { chara: char });
          }

          let result: string[];
          if (effect.delimiterType === "regex") {
            try {
              const regexMatch = delimiter.match(/^\/(.+)\/([gimuy]*)$/);
              if (regexMatch) {
                const [, pattern, flags] = regexMatch;
                const regex = new RegExp(pattern, flags);
                result = source.split(regex);
              } else {
                const regex = new RegExp(delimiter);
                result = source.split(regex);
              }
            } catch (error) {
              result = [source];
            }
          } else {
            result = source.split(delimiter);
          }

          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            JSON.stringify(result),
          );
          break;
        }
        case "v2JoinArrayVar": {
          try {
            let varValue =
              effect.varType === "value"
                ? parseTriggerText(effect.var, { chara: char })
                : getVar(parseTriggerText(effect.var, { chara: char }));
            let arr = JSON.parse(varValue);
            let delimiter =
              effect.delimiterType === "value"
                ? parseTriggerText(effect.delimiter, { chara: char })
                : getVar(parseTriggerText(effect.delimiter, { chara: char }));
            setVar(
              parseTriggerText(effect.outputVar, { chara: char }),
              arr.join(delimiter),
            );
          } catch (error) {
            setVar(parseTriggerText(effect.outputVar, { chara: char }), "");
          }
          break;
        }
        case "v2GetCharacterDesc": {
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            char.desc,
          );
          break;
        }
        case "v2SetCharacterDesc": {
          let value =
            effect.valueType === "value"
              ? parseTriggerText(effect.value, { chara: char })
              : getVar(parseTriggerText(effect.value, { chara: char }));
          char.desc = value;
          persistCharacterDescription();
          break;
        }
        case "v2GetPersonaDesc": {
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            personaStore.activePersona?.personaPrompt ?? "",
          );
          break;
        }
        case "v2SetPersonaDesc": {
          const value =
            effect.valueType === "value"
              ? parseTriggerText(effect.value, { chara: char })
              : getVar(parseTriggerText(effect.value, { chara: char }));
          personaStore.requireActive("v2SetPersonaDesc").personaPrompt = value;
          break;
        }
        case "v2GetReplaceGlobalNote": {
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            char.replaceGlobalNote ?? "",
          );
          break;
        }
        case "v2SetReplaceGlobalNote": {
          const value =
            effect.valueType === "value"
              ? parseTriggerText(effect.value, { chara: char })
              : getVar(parseTriggerText(effect.value, { chara: char }));
          char.replaceGlobalNote = value;
          persistReplaceGlobalNote();
          break;
        }
        case "v2MakeArrayVar": {
          const varName = parseTriggerText(effect.var, { chara: char });
          if (varName.startsWith("[") && varName.endsWith("]")) {
            return;
          }

          setVar(varName, "[]");
          break;
        }
        case "v2GetArrayVarLength": {
          try {
            const varName = parseTriggerText(effect.var, { chara: char });
            let varValue = getVar(varName);
            let arr = JSON.parse(varValue);
            setVar(
              parseTriggerText(effect.outputVar, { chara: char }),
              arr.length.toString(),
            );
          } catch (error) {
            setVar(parseTriggerText(effect.outputVar, { chara: char }), "0");
          }
          break;
        }
        case "v2GetArrayVar": {
          try {
            const varName = parseTriggerText(effect.var, { chara: char });
            let varValue = getVar(varName);
            let arr = JSON.parse(varValue);
            let index =
              effect.indexType === "value"
                ? Number(parseTriggerText(effect.index, { chara: char }))
                : Number(
                    getVar(parseTriggerText(effect.index, { chara: char })),
                  );
            setVar(
              parseTriggerText(effect.outputVar, { chara: char }),
              arr[index] ?? "null",
            );
          } catch (error) {
            setVar(parseTriggerText(effect.outputVar, { chara: char }), "null");
          }
          break;
        }
        case "v2PushArrayVar": {
          try {
            const varName = parseTriggerText(effect.var, { chara: char });
            let varValue = getVar(varName);
            let arr = JSON.parse(varValue);
            let value =
              effect.valueType === "value"
                ? parseTriggerText(effect.value, { chara: char })
                : getVar(parseTriggerText(effect.value, { chara: char }));
            arr.push(value);
            setVar(varName, JSON.stringify(arr));
          } catch (error) {
            const varName = parseTriggerText(effect.var, { chara: char });
            setVar(varName, "[]");
          }
          break;
        }
        case "v2PopArrayVar": {
          try {
            const varName = parseTriggerText(effect.var, { chara: char });
            let varValue = getVar(varName);
            let arr = JSON.parse(varValue);
            setVar(
              parseTriggerText(effect.outputVar, { chara: char }),
              arr.pop() ?? "null",
            );
            setVar(varName, JSON.stringify(arr));
          } catch (error) {
            const varName = parseTriggerText(effect.var, { chara: char });
            setVar(varName, "[]");
            setVar(parseTriggerText(effect.outputVar, { chara: char }), "null");
          }
          break;
        }
        case "v2ShiftArrayVar": {
          try {
            const varName = parseTriggerText(effect.var, { chara: char });
            let varValue = getVar(varName);
            let arr = JSON.parse(varValue);
            setVar(
              parseTriggerText(effect.outputVar, { chara: char }),
              arr.shift() ?? "null",
            );
            setVar(varName, JSON.stringify(arr));
          } catch (error) {
            const varName = parseTriggerText(effect.var, { chara: char });
            setVar(varName, "[]");
            setVar(parseTriggerText(effect.outputVar, { chara: char }), "null");
          }
          break;
        }
        case "v2UnshiftArrayVar": {
          try {
            const varName = parseTriggerText(effect.var, { chara: char });
            let varValue = getVar(varName);
            let arr = JSON.parse(varValue);
            let value =
              effect.valueType === "value"
                ? parseTriggerText(effect.value, { chara: char })
                : getVar(parseTriggerText(effect.value, { chara: char }));
            arr.unshift(value);
            setVar(varName, JSON.stringify(arr));
          } catch (error) {
            const varName = parseTriggerText(effect.var, { chara: char });
            setVar(varName, "[]");
          }
          break;
        }
        case "v2SpliceArrayVar": {
          try {
            const varName = parseTriggerText(effect.var, { chara: char });
            let varValue = getVar(varName);
            let arr = JSON.parse(varValue);
            let start =
              effect.startType === "value"
                ? Number(parseTriggerText(effect.start, { chara: char }))
                : Number(
                    getVar(parseTriggerText(effect.start, { chara: char })),
                  );
            let value =
              effect.itemType === "value"
                ? parseTriggerText(effect.item, { chara: char })
                : getVar(parseTriggerText(effect.item, { chara: char }));
            arr.splice(start, 0, value);
            setVar(varName, JSON.stringify(arr));
          } catch (error) {
            const varName = parseTriggerText(effect.var, { chara: char });
            setVar(varName, "[]");
          }
          break;
        }
        case "v2SliceArrayVar": {
          try {
            const varName = parseTriggerText(effect.var, { chara: char });
            let varValue = getVar(varName);
            let arr = JSON.parse(varValue);
            let start =
              effect.startType === "value"
                ? Number(parseTriggerText(effect.start, { chara: char }))
                : Number(
                    getVar(parseTriggerText(effect.start, { chara: char })),
                  );
            let end =
              effect.endType === "value"
                ? Number(parseTriggerText(effect.end, { chara: char }))
                : Number(getVar(parseTriggerText(effect.end, { chara: char })));

            setVar(
              parseTriggerText(effect.outputVar, { chara: char }),
              JSON.stringify(arr.slice(start, end)),
            );
          } catch (error) {
            setVar(parseTriggerText(effect.outputVar, { chara: char }), "[]");
          }
          break;
        }
        case "v2GetIndexOfValueInArrayVar": {
          try {
            const varName = parseTriggerText(effect.var, { chara: char });
            let varValue = getVar(varName);
            let arr = JSON.parse(varValue);
            let value =
              effect.valueType === "value"
                ? parseTriggerText(effect.value, { chara: char })
                : getVar(parseTriggerText(effect.value, { chara: char }));
            setVar(
              parseTriggerText(effect.outputVar, { chara: char }),
              arr.indexOf(value).toString(),
            );
          } catch (error) {
            setVar(parseTriggerText(effect.outputVar, { chara: char }), "-1");
          }
          break;
        }
        case "v2RemoveIndexFromArrayVar": {
          try {
            const varName = parseTriggerText(effect.var, { chara: char });
            let varValue = getVar(varName);
            let arr = JSON.parse(varValue);
            let index =
              effect.indexType === "value"
                ? Number(parseTriggerText(effect.index, { chara: char }))
                : Number(
                    getVar(parseTriggerText(effect.index, { chara: char })),
                  );
            arr.splice(index, 1);
            setVar(varName, JSON.stringify(arr));
          } catch (error) {
            const varName = parseTriggerText(effect.var, { chara: char });
            setVar(varName, "[]");
          }
          break;
        }
        case "v2ConcatString": {
          let source1 =
            effect.source1Type === "value"
              ? parseTriggerText(effect.source1, { chara: char })
              : getVar(parseTriggerText(effect.source1, { chara: char }));
          let source2 =
            effect.source2Type === "value"
              ? parseTriggerText(effect.source2, { chara: char })
              : getVar(parseTriggerText(effect.source2, { chara: char }));
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            source1 + source2,
          );
          break;
        }
        case "v2GetLastUserMessage": {
          let lastUserMessage = chat.message
            .slice()
            .reverse()
            .find((v) => v.role === "user");
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            lastUserMessage?.data ?? "null",
          );
          break;
        }
        case "v2GetLastCharMessage": {
          let lastCharMessage = chat.message
            .slice()
            .reverse()
            .find((v) => v.role === "char");
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            lastCharMessage?.data ?? "null",
          );
          break;
        }
        case "v2GetFirstMessage": {
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            chat.fmIndex === -1
              ? char.firstMessage
              : char.alternateGreetings[chat.fmIndex],
          );
          break;
        }
        case "v2GetAlertInput": {
          if (arg.displayMode) {
            return;
          }
          let value = await alertInput(
            effect.displayType === "value"
              ? parseTriggerText(effect.display, { chara: char })
              : getVar(parseTriggerText(effect.display, { chara: char })),
          );
          setVar(parseTriggerText(effect.outputVar, { chara: char }), value);
          break;
        }
        case "v2GetAlertSelect": {
          if (arg.displayMode) {
            return;
          }
          const display =
            effect.displayType === "value"
              ? parseTriggerText(effect.display, { chara: char })
              : getVar(parseTriggerText(effect.display, { chara: char }));
          const value =
            effect.valueType === "value"
              ? parseTriggerText(effect.value, { chara: char })
              : getVar(parseTriggerText(effect.value, { chara: char }));
          const options = value.split("|");
          let result = await alertSelect(options, display);
          setVar(parseTriggerText(effect.outputVar, { chara: char }), result);
          break;
        }
        case "v2SetArrayVar": {
          const value =
            effect.valueType === "value"
              ? parseTriggerText(effect.value, { chara: char })
              : getVar(parseTriggerText(effect.value, { chara: char }));
          const index =
            effect.indexType === "value"
              ? Number(parseTriggerText(effect.index, { chara: char }))
              : Number(getVar(parseTriggerText(effect.index, { chara: char })));
          if (Number.isNaN(index)) {
            break;
          }
          try {
            const varName = parseTriggerText(effect.var, { chara: char });
            let varValue = getVar(varName);
            let arr = JSON.parse(varValue);
            arr[index] = value;
            setVar(varName, JSON.stringify(arr));
          } catch (error) {}
          break;
        }
        case "v2GetDisplayState": {
          if (!arg.displayMode) {
            return;
          }

          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            arg.displayData ?? "null",
          );
          break;
        }
        case "v2SetDisplayState": {
          if (!arg.displayMode) {
            return;
          }
          arg.displayData =
            effect.valueType === "value"
              ? parseTriggerText(effect.value, { chara: char })
              : getVar(parseTriggerText(effect.value, { chara: char }));
          break;
        }
        case "v2UpdateGUI": {
          ReloadGUIPointer.set(get(ReloadGUIPointer) + 1);
          break;
        }
        case "v2UpdateChatAt": {
          ReloadChatPointer.update((v) => {
            v[effect.index] = (v[effect.index] ?? 0) + 1;
            return v;
          });
          break;
        }
        case "v2Wait": {
          let value =
            effect.valueType === "value"
              ? Number(parseTriggerText(effect.value, { chara: char }))
              : Number(getVar(parseTriggerText(effect.value, { chara: char })));
          await sleep(value * 1000);
          break;
        }
        case "v2GetRequestState": {
          if (!arg.displayMode) {
            return;
          }
          const json = JSON.parse(arg.displayData) as OpenAIChat[];
          const index =
            effect.indexType === "value"
              ? Number(parseTriggerText(effect.index, { chara: char }))
              : Number(getVar(parseTriggerText(effect.index, { chara: char })));
          const content = json?.[index]?.content ?? "null";
          setVar(parseTriggerText(effect.outputVar, { chara: char }), content);
          break;
        }
        case "v2SetRequestState": {
          if (!arg.displayMode) {
            return;
          }
          const json = JSON.parse(arg.displayData) as OpenAIChat[];
          const index =
            effect.indexType === "value"
              ? Number(parseTriggerText(effect.index, { chara: char }))
              : Number(getVar(parseTriggerText(effect.index, { chara: char })));
          const value =
            effect.valueType === "value"
              ? parseTriggerText(effect.value, { chara: char })
              : getVar(parseTriggerText(effect.value, { chara: char }));
          json[index].content = value;
          arg.displayData = JSON.stringify(json);
          break;
        }
        case "v2GetRequestStateRole": {
          if (!arg.displayMode) {
            return;
          }
          const json = JSON.parse(arg.displayData) as OpenAIChat[];
          const index =
            effect.indexType === "value"
              ? Number(parseTriggerText(effect.index, { chara: char }))
              : Number(getVar(parseTriggerText(effect.index, { chara: char })));
          const content = json?.[index]?.role ?? "null";
          setVar(parseTriggerText(effect.outputVar, { chara: char }), content);
          break;
        }
        case "v2SetRequestStateRole": {
          if (!arg.displayMode) {
            return;
          }
          const json = JSON.parse(arg.displayData) as OpenAIChat[];
          const index =
            effect.indexType === "value"
              ? Number(parseTriggerText(effect.index, { chara: char }))
              : Number(getVar(parseTriggerText(effect.index, { chara: char })));
          const value =
            effect.valueType === "value"
              ? parseTriggerText(effect.value, { chara: char })
              : getVar(parseTriggerText(effect.value, { chara: char }));
          if (value === "user" || value === "assistant" || value === "system") {
            json[index].role = value;
          }
          arg.displayData = JSON.stringify(json);
          break;
        }

        case "v2GetRequestStateLength": {
          if (!arg.displayMode) {
            return;
          }
          const json = JSON.parse(arg.displayData) as OpenAIChat[];
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            json.length.toString(),
          );
          break;
        }
        case "v2QuickSearchChat": {
          const value =
            effect.valueType === "value"
              ? parseTriggerText(effect.value, { chara: char })
              : getVar(parseTriggerText(effect.value, { chara: char }));
          const depth =
            effect.depthType === "value"
              ? Number(parseTriggerText(effect.depth, { chara: char }))
              : Number(getVar(parseTriggerText(effect.depth, { chara: char })));
          const condition = effect.condition;

          if (isNaN(depth)) {
            setVar(parseTriggerText(effect.outputVar, { chara: char }), "0");
            break;
          }
          let pass = false;
          let da = chat.message
            .slice(0 - depth)
            .map((v) => v.data)
            .join(" ");
          if (condition === "strict") {
            pass = da.split(" ").includes(value);
          } else if (condition === "loose") {
            pass = da.toLowerCase().includes(value.toLowerCase());
          } else if (condition === "regex") {
            pass = new RegExp(value).test(da);
          }
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            pass ? "1" : "0",
          );
          break;
        }
        case "v2Tokenize": {
          const value =
            effect.valueType === "value"
              ? parseTriggerText(effect.value, { chara: char })
              : getVar(parseTriggerText(effect.value, { chara: char }));
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            (await tokenize(value)).toString(),
          );
          break;
        }
        case "v2GetAllLorebooks": {
          char.globalLore = char.globalLore ?? [];
          const allPrompts: string[] = [];
          for (const lore of char.globalLore) {
            if (lore && lore.content !== undefined) {
              allPrompts.push(lore.content);
            }
          }
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            JSON.stringify(allPrompts),
          );
          break;
        }
        case "v2GetLorebookByName": {
          char.globalLore = char.globalLore ?? [];
          const name =
            effect.nameType === "value"
              ? parseTriggerText(effect.name, { chara: char })
              : getVar(parseTriggerText(effect.name, { chara: char }));
          const regex = new RegExp(name, "i");
          const matchingIndices: number[] = [];
          for (let i = 0; i < char.globalLore.length; i++) {
            const lore = char.globalLore[i];
            if (
              lore &&
              lore.comment !== undefined &&
              regex.test(lore.comment)
            ) {
              matchingIndices.push(i);
            }
          }
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            JSON.stringify(matchingIndices),
          );
          break;
        }
        case "v2GetLorebookByIndex": {
          char.globalLore = char.globalLore ?? [];
          let index =
            effect.indexType === "value"
              ? Number(parseTriggerText(effect.index, { chara: char }))
              : Number(getVar(parseTriggerText(effect.index, { chara: char })));
          if (
            Number.isNaN(index) ||
            index < 0 ||
            index >= char.globalLore.length
          ) {
            setVar(parseTriggerText(effect.outputVar, { chara: char }), "null");
          } else {
            const loreEntry = char.globalLore[index];
            if (loreEntry && loreEntry.content !== undefined) {
              setVar(
                parseTriggerText(effect.outputVar, { chara: char }),
                loreEntry.content,
              );
            } else {
              setVar(
                parseTriggerText(effect.outputVar, { chara: char }),
                "null",
              );
            }
          }
          break;
        }
        case "v2CreateLorebook": {
          char.globalLore = char.globalLore ?? [];
          const name =
            effect.nameType === "value"
              ? parseTriggerText(effect.name, { chara: char })
              : getVar(parseTriggerText(effect.name, { chara: char }));
          const key =
            effect.keyType === "value"
              ? parseTriggerText(effect.key, { chara: char })
              : getVar(parseTriggerText(effect.key, { chara: char }));
          const content =
            effect.contentType === "value"
              ? parseTriggerText(effect.content, { chara: char })
              : getVar(parseTriggerText(effect.content, { chara: char }));
          const insertOrder =
            effect.insertOrderType === "value"
              ? Number(parseTriggerText(effect.insertOrder, { chara: char }))
              : Number(
                  getVar(parseTriggerText(effect.insertOrder, { chara: char })),
                );

          char.globalLore.push({
            key: key,
            comment: name,
            content: content,
            mode: "normal",
            insertorder: Number.isNaN(insertOrder) ? 100 : insertOrder,
            alwaysActive: false,
            secondkey: "",
            selective: false,
          });

          persistGlobalLore();
          break;
        }
        case "v2ModifyLorebookByIndex": {
          char.globalLore = char.globalLore ?? [];
          let index =
            effect.indexType === "value"
              ? Number(parseTriggerText(effect.index, { chara: char }))
              : Number(getVar(parseTriggerText(effect.index, { chara: char })));

          if (
            Number.isNaN(index) ||
            index < 0 ||
            index >= char.globalLore.length ||
            !char.globalLore[index]
          ) {
            break;
          }

          const currentLore = char.globalLore[index];

          let name =
            effect.nameType === "value"
              ? parseTriggerText(effect.name, { chara: char })
              : getVar(parseTriggerText(effect.name, { chara: char }));
          name = name.replace(/{{slot}}/g, currentLore.comment || "");
          char.globalLore[index].comment = name;

          let key =
            effect.keyType === "value"
              ? parseTriggerText(effect.key, { chara: char })
              : getVar(parseTriggerText(effect.key, { chara: char }));
          key = key.replace(/{{slot}}/g, currentLore.key || "");
          char.globalLore[index].key = key;

          let content =
            effect.contentType === "value"
              ? parseTriggerText(effect.content, { chara: char })
              : getVar(parseTriggerText(effect.content, { chara: char }));
          content = content.replace(/{{slot}}/g, currentLore.content || "");
          char.globalLore[index].content = content;

          let insertOrder =
            effect.insertOrderType === "value"
              ? parseTriggerText(effect.insertOrder, { chara: char })
              : getVar(parseTriggerText(effect.insertOrder, { chara: char }));
          insertOrder = insertOrder.replace(
            /{{slot}}/g,
            (currentLore.insertorder || 100).toString(),
          );
          const insertOrderNum = Number(insertOrder);
          if (!Number.isNaN(insertOrderNum)) {
            char.globalLore[index].insertorder = insertOrderNum;
          }

          persistGlobalLore();
          break;
        }
        case "v2DeleteLorebookByIndex": {
          char.globalLore = char.globalLore ?? [];
          let index =
            effect.indexType === "value"
              ? Number(parseTriggerText(effect.index, { chara: char }))
              : Number(getVar(parseTriggerText(effect.index, { chara: char })));

          if (
            Number.isNaN(index) ||
            index < 0 ||
            index >= char.globalLore.length ||
            !char.globalLore[index]
          ) {
            break;
          }

          char.globalLore.splice(index, 1);

          persistGlobalLore();
          break;
        }
        case "v2GetLorebookCountNew": {
          char.globalLore = char.globalLore ?? [];
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            char.globalLore.length.toString(),
          );
          break;
        }
        case "v2SetLorebookAlwaysActive": {
          char.globalLore = char.globalLore ?? [];
          let index =
            effect.indexType === "value"
              ? Number(parseTriggerText(effect.index, { chara: char }))
              : Number(getVar(parseTriggerText(effect.index, { chara: char })));

          if (
            Number.isNaN(index) ||
            index < 0 ||
            index >= char.globalLore.length ||
            !char.globalLore[index]
          ) {
            break;
          }

          char.globalLore[index].alwaysActive = effect.value;

          persistGlobalLore();
          break;
        }
        case "v2RegexTest": {
          try {
            const value =
              effect.valueType === "value"
                ? parseTriggerText(effect.value, { chara: char })
                : getVar(parseTriggerText(effect.value, { chara: char }));
            const regexPattern =
              effect.regexType === "value"
                ? parseTriggerText(effect.regex, { chara: char })
                : getVar(parseTriggerText(effect.regex, { chara: char }));
            const flags =
              effect.flagsType === "value"
                ? parseTriggerText(effect.flags, { chara: char })
                : getVar(parseTriggerText(effect.flags, { chara: char }));
            const regex = new RegExp(regexPattern, flags);
            const result = regex.test(value);
            setVar(
              parseTriggerText(effect.outputVar, { chara: char }),
              result ? "1" : "0",
            );
          } catch (error) {
            setVar(parseTriggerText(effect.outputVar, { chara: char }), "0");
          }
          break;
        }
        case "v2GetAuthorNote": {
          setVar(
            parseTriggerText(effect.outputVar, { chara: char }),
            authorNoteContent,
          );
          break;
        }
        case "v2SetAuthorNote": {
          const value =
            effect.valueType === "value"
              ? parseTriggerText(effect.value, { chara: char })
              : getVar(parseTriggerText(effect.value, { chara: char }));
          if (noteSource.mode === "local") {
            chat.note = authorNoteContent = value;
            if (!arg.displayMode) persistTargetAuthorNote(value);
          } else if (!arg.displayMode) {
            if (!(await globalAuthorNoteStore.getAllowScriptWrite())) {
              alertToast(language.globalAuthorNote.scriptBlocked);
              break;
            }
            if (!sharedNote || sharedNote.id === "__none__") break;
            try {
              await globalAuthorNoteStore.setScriptContent(sharedNote, value);
              authorNoteContent = value;
            } catch (error) {
              if (!(error instanceof AuthorNoteError)) throw error;
              alertToast(language.globalAuthorNote.scriptConflict);
            }
          }
          break;
        }
        case "v2MakeDictVar": {
          if (effect.var.startsWith("{") && effect.var.endsWith("}")) {
            return;
          }

          setVar(parseTriggerText(effect.var, { chara: char }), "{}");
          break;
        }
        case "v2GetDictVar": {
          try {
            let varValue =
              effect.varType === "value"
                ? parseTriggerText(effect.var, { chara: char })
                : getVar(parseTriggerText(effect.var, { chara: char }));
            let dict = JSON.parse(varValue);
            let key =
              effect.keyType === "value"
                ? parseTriggerText(effect.key, { chara: char })
                : getVar(parseTriggerText(effect.key, { chara: char }));
            setVar(
              parseTriggerText(effect.outputVar, { chara: char }),
              dict[key] ?? "null",
            );
          } catch (error) {
            setVar(parseTriggerText(effect.outputVar, { chara: char }), "null");
          }
          break;
        }
        case "v2SetDictVar": {
          try {
            const value =
              effect.valueType === "value"
                ? parseTriggerText(effect.value, { chara: char })
                : getVar(parseTriggerText(effect.value, { chara: char }));
            const key =
              effect.keyType === "value"
                ? parseTriggerText(effect.key, { chara: char })
                : getVar(parseTriggerText(effect.key, { chara: char }));

            if (effect.varType === "value") {
              break;
            }

            let varValue = getVar(
              parseTriggerText(effect.var, { chara: char }),
            );
            let dict = JSON.parse(varValue);
            dict[key] = value;
            setVar(
              parseTriggerText(effect.var, { chara: char }),
              JSON.stringify(dict),
            );
          } catch (error) {
            if (effect.varType === "var") {
              const value =
                effect.valueType === "value"
                  ? parseTriggerText(effect.value, { chara: char })
                  : getVar(parseTriggerText(effect.value, { chara: char }));
              const key =
                effect.keyType === "value"
                  ? parseTriggerText(effect.key, { chara: char })
                  : getVar(parseTriggerText(effect.key, { chara: char }));
              let dict = {};
              dict[key] = value;
              setVar(
                parseTriggerText(effect.var, { chara: char }),
                JSON.stringify(dict),
              );
            }
          }
          break;
        }
        case "v2DeleteDictKey": {
          try {
            if (effect.varType === "value") {
              break;
            }

            let varValue = getVar(
              parseTriggerText(effect.var, { chara: char }),
            );
            let dict = JSON.parse(varValue);
            let key =
              effect.keyType === "value"
                ? parseTriggerText(effect.key, { chara: char })
                : getVar(parseTriggerText(effect.key, { chara: char }));
            delete dict[key];
            setVar(
              parseTriggerText(effect.var, { chara: char }),
              JSON.stringify(dict),
            );
          } catch (error) {
            if (effect.varType === "var") {
              setVar(parseTriggerText(effect.var, { chara: char }), "{}");
            }
          }
          break;
        }
        case "v2HasDictKey": {
          try {
            let varValue =
              effect.varType === "value"
                ? parseTriggerText(effect.var, { chara: char })
                : getVar(parseTriggerText(effect.var, { chara: char }));
            let dict = JSON.parse(varValue);
            let key =
              effect.keyType === "value"
                ? parseTriggerText(effect.key, { chara: char })
                : getVar(parseTriggerText(effect.key, { chara: char }));
            setVar(
              parseTriggerText(effect.outputVar, { chara: char }),
              Object.hasOwn(dict, key) ? "1" : "0",
            );
          } catch (error) {
            setVar(parseTriggerText(effect.outputVar, { chara: char }), "0");
          }
          break;
        }
        case "v2ClearDict": {
          if (effect.var.startsWith("{") && effect.var.endsWith("}")) {
            return;
          }
          setVar(parseTriggerText(effect.var, { chara: char }), "{}");
          break;
        }
        case "v2GetDictSize": {
          try {
            let varValue =
              effect.varType === "value"
                ? parseTriggerText(effect.var, { chara: char })
                : getVar(parseTriggerText(effect.var, { chara: char }));
            let dict = JSON.parse(varValue);
            setVar(
              parseTriggerText(effect.outputVar, { chara: char }),
              Object.keys(dict).length.toString(),
            );
          } catch (error) {
            setVar(parseTriggerText(effect.outputVar, { chara: char }), "0");
          }
          break;
        }
        case "v2GetDictKeys": {
          try {
            let varValue =
              effect.varType === "value"
                ? parseTriggerText(effect.var, { chara: char })
                : getVar(parseTriggerText(effect.var, { chara: char }));
            let dict = JSON.parse(varValue);
            let keys = Object.keys(dict);
            setVar(
              parseTriggerText(effect.outputVar, { chara: char }),
              JSON.stringify(keys),
            );
          } catch (error) {
            setVar(parseTriggerText(effect.outputVar, { chara: char }), "[]");
          }
          break;
        }
        case "v2GetDictValues": {
          try {
            let varValue =
              effect.varType === "value"
                ? parseTriggerText(effect.var, { chara: char })
                : getVar(parseTriggerText(effect.var, { chara: char }));
            let dict = JSON.parse(varValue);
            let values = Object.values(dict);
            setVar(
              parseTriggerText(effect.outputVar, { chara: char }),
              JSON.stringify(values),
            );
          } catch (error) {
            setVar(parseTriggerText(effect.outputVar, { chara: char }), "[]");
          }
          break;
        }
        case "v2Calculate": {
          try {
            let expression =
              effect.expressionType === "value"
                ? parseTriggerText(effect.expression, { chara: char })
                : getVar(parseTriggerText(effect.expression, { chara: char }));
            expression = expression.replace(
              /\$([a-zA-Z0-9_]+)/g,
              (_, varName) => {
                const varValue = getVar(varName);
                const parsed = parseFloat(varValue);
                return isNaN(parsed) ? "0" : parsed.toString();
              },
            );

            const result = calcString(expression);
            setVar(
              parseTriggerText(effect.outputVar, { chara: char }),
              result.toString(),
            );
          } catch (error) {
            setVar(parseTriggerText(effect.outputVar, { chara: char }), "0");
          }
          break;
        }
        case "v2ReplaceString": {
          try {
            const source =
              effect.sourceType === "value"
                ? parseTriggerText(effect.source, { chara: char })
                : getVar(parseTriggerText(effect.source, { chara: char }));
            const regexPattern =
              effect.regexType === "value"
                ? parseTriggerText(effect.regex, { chara: char })
                : getVar(parseTriggerText(effect.regex, { chara: char }));
            const resultFormat =
              effect.resultType === "value"
                ? parseTriggerText(effect.result, { chara: char })
                : getVar(parseTriggerText(effect.result, { chara: char }));
            const replacement =
              effect.replacementType === "value"
                ? parseTriggerText(effect.replacement, { chara: char })
                : getVar(parseTriggerText(effect.replacement, { chara: char }));
            const flags =
              effect.flagsType === "value"
                ? parseTriggerText(effect.flags, { chara: char })
                : getVar(parseTriggerText(effect.flags, { chara: char }));

            const regex = new RegExp(regexPattern, flags);
            const result = source.replace(regex, (...args) => {
              const match = args[0];
              const groups = args.slice(1, -2);

              const targetGroupMatch = resultFormat.match(/^\$(\d+)$/);
              if (targetGroupMatch) {
                const targetIndex = Number(targetGroupMatch[1]);
                if (targetIndex === 0) {
                  return replacement;
                } else {
                  const targetGroup = groups[targetIndex - 1];
                  if (targetGroup) {
                    return match.replace(targetGroup, replacement);
                  }
                }
              }

              return resultFormat
                .replace(/\$[0-9]+/g, (placeholder) => {
                  const index = Number(placeholder.slice(1));
                  return index === 0 ? match : groups[index - 1] || "";
                })
                .replace(/\$&/g, match)
                .replace(/\$\$/g, "$");
            });
            setVar(parseTriggerText(effect.outputVar, { chara: char }), result);
          } catch (error) {
            const source =
              effect.sourceType === "value"
                ? parseTriggerText(effect.source, { chara: char })
                : getVar(parseTriggerText(effect.source, { chara: char }));
            setVar(parseTriggerText(effect.outputVar, { chara: char }), source);
          }
          break;
        }
        case "v2Comment": {
          break;
        }
      }
    }
  }

  let caculatedTokens = 0;
  if (additonalSysPrompt.start) {
    caculatedTokens += await tokenize(additonalSysPrompt.start);
  }
  if (additonalSysPrompt.historyend) {
    caculatedTokens += await tokenize(additonalSysPrompt.historyend);
  }
  if (additonalSysPrompt.promptend) {
    caculatedTokens += await tokenize(additonalSysPrompt.promptend);
  }
  if (varChanged) {
    const targetChat = getTargetChat();
    if (targetChat) {
      targetChat.scriptstate = chat.scriptstate;
      if (targetChat.id) characterStore.markChatDirty(targetChat.id);
    }
    ReloadGUIPointer.set(get(ReloadGUIPointer) + 1);
  }

  return {
    additonalSysPrompt,
    chat,
    tokens: caculatedTokens,
    stopSending,
    sendAIprompt,
    displayData: arg.displayData,
    tempVars: arg.tempVars,
  };
}
