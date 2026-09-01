import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import { characterStore } from "src/ts/stores/domain/characterStore.svelte";
import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { get } from "svelte/store";
import {
  CharEmotion,
  scriptCacheRevision,
  selectedCharID,
} from "../stores.svelte";
import type { character, customscript, groupChat } from "../storage/database/schema";
import { resolveChatTarget, type ChatExecutionTarget } from "../chatTarget";

import { downloadFile } from "../globalApi.svelte";
import { alertError, alertNormal } from "../alert";
import { language } from "src/lang";
import { selectSingleFile } from "../util";
import {
  assetRegex,
  type CbsConditions,
  risuChatParser as risuChatParserOrg,
  type simpleCharacterArgument,
} from "../parser/parser.svelte";
import { getModuleAssets, getModuleRegexScripts } from "./modules";
import { HypaProcesser } from "./memory/hypamemory";
import { runLuaEditTrigger } from "./scriptings";
import { pluginV2 } from "../plugins/plugins.svelte";
import { runTrigger } from "./triggers";
import { RegexCompileCache } from "./regexCompileCache";

const dreg = /{{data}}/g;
const randomness = /\|\|\|/g;

export type ScriptMode =
  "editinput" | "editoutput" | "editprocess" | "editdisplay";

type pScript = {
  script: customscript;
  order: number;
  actions: string[];
};

export async function processScript(
  char: character | groupChat,
  data: string,
  mode: ScriptMode,
  cbsConditions: CbsConditions = {},
  chatTarget?: ChatExecutionTarget,
) {
  return (
    await processScriptFull(char, data, mode, -1, cbsConditions, chatTarget)
  ).data;
}

export function exportRegex(s?: customscript[]) {
  let db = settingsStore.state;
  const script = s ?? db.globalscript;
  const data = Buffer.from(
    JSON.stringify({
      type: "regex",
      data: script,
    }),
    "utf-8",
  );
  downloadFile(`regexscript_export.json`, data);
  alertNormal(language.successExport);
}

export async function importRegex(o?: customscript[]): Promise<customscript[]> {
  o = o ?? [];
  const filedata = (await selectSingleFile(["json"])).data;
  if (!filedata) {
    return o;
  }
  let db = settingsStore.state;
  try {
    const imported = JSON.parse(Buffer.from(filedata).toString("utf-8"));
    if (imported.type === "regex" && imported.data) {
      const datas: customscript[] = imported.data;
      const script = o;
      for (const data of datas) {
        script.push(data);
      }
      return o;
    } else {
      alertError("File invaid or corrupted");
    }
  } catch (error) {
    alertError(error);
  }
  return o;
}

let bestMatchCache = new Map<string, string>();
let processScriptCache = new Map<string, string>();
const SCRIPT_CACHE_MAX_ENTRIES = 128;
const SCRIPT_CACHE_MAX_CHARS = 1024 * 1024;
let processScriptCacheChars = 0;
const compiledRegexCache = new RegexCompileCache(256);

function generateScriptCacheKey(
  scripts: customscript[],
  data: string,
  mode: ScriptMode,
  chatID = -1,
  cbsConditions: CbsConditions = {},
  chatTarget?: ChatExecutionTarget,
) {
  const targetKey = chatTarget
    ? `${chatTarget.characterId}:${chatTarget.chatId}`
    : "selected";
  let hash =
    data +
    "|||" +
    mode +
    "|||" +
    scriptCacheRevision +
    "|||" +
    targetKey +
    "|||";
  for (const script of scripts) {
    if (script.type !== mode) {
      continue;
    }
    hash += `${script.flag?.includes("<cbs>") ? risuChatParser(script.in, { chatID: chatID, cbsConditions, chatTarget }) : script.in}|||${script.out}${chatID}|||${script.flag ?? ""}|||${script.ableFlag ? 1 : 0}`;
  }
  return hash;
}

function cacheScript(hash: string, result: string) {
  const previous = processScriptCache.get(hash);
  if (previous) processScriptCacheChars -= hash.length + previous.length;
  processScriptCache.set(hash, result);
  processScriptCacheChars += hash.length + result.length;

  while (
    processScriptCache.size > SCRIPT_CACHE_MAX_ENTRIES ||
    processScriptCacheChars > SCRIPT_CACHE_MAX_CHARS
  ) {
    const oldest = processScriptCache.keys().next().value;
    if (!oldest) break;
    const value = processScriptCache.get(oldest) ?? "";
    processScriptCacheChars -= oldest.length + value.length;
    processScriptCache.delete(oldest);
  }
}

function getScriptCache(hash: string) {
  return processScriptCache.get(hash);
}

export function resetScriptCache() {
  processScriptCache = new Map();
  processScriptCacheChars = 0;
  bestMatchCache.clear();
  compiledRegexCache.clear();
}

export async function processScriptFull(
  char: character | groupChat | simpleCharacterArgument,
  data: string,
  mode: ScriptMode,
  chatID = -1,
  cbsConditions: CbsConditions = {},
  chatTarget?: ChatExecutionTarget,
) {
  let db = settingsStore.state;
  let emoChanged = false;
  data = await runLuaEditTrigger(
    char,
    mode,
    data,
    { index: chatID },
    chatTarget,
  );

  const resolvedTarget = chatTarget ? resolveChatTarget(chatTarget) : null;

  if (mode === "editdisplay") {
    const displayCharacter = resolvedTarget?.character ?? characterStore.currentCharacter;
    const displayChat = resolvedTarget?.chat ?? characterStore.currentChat;
    if (displayCharacter && displayCharacter.type !== "group" && displayChat) {
      try {
        const perf = performance.now();
        const d = await runTrigger(displayCharacter, "display", {
          chat: displayChat,
          target: chatTarget,
          displayMode: true,
          displayData: data,
        });

        data = d?.displayData ?? data;
        console.log("Trigger time", performance.now() - perf);
      } catch (e) {
        console.error(e);
      }
    }
  }

  if (pluginV2[mode].size > 0) {
    for (const plugin of pluginV2[mode]) {
      const res = await plugin(data);
      if (res !== null && res !== undefined) {
        data = res;
      }
    }
  }

  data = risuChatParser(data, { chatID: chatID, cbsConditions, chatTarget });
  const moduleRoom = resolvedTarget?.character ?? (char.type === "simple" ? undefined : char);
  const scripts = (presetStore.state.presetRegex ?? [])
    .concat(char.customscript ?? [])
    .concat(getModuleRegexScripts(moduleRoom, undefined, resolvedTarget?.chat))
    .filter((script): script is customscript => !!script);
  const hash = generateScriptCacheKey(
    scripts,
    data,
    mode,
    chatID,
    cbsConditions,
    chatTarget,
  );
  const cached = getScriptCache(hash);
  if (cached) {
    return { data: cached, emoChanged: false };
  }

  if (scripts.length === 0) {
    cacheScript(hash, data);
    return { data, emoChanged };
  }
  function executeScript(pscript: pScript) {
    const script = pscript.script;

    if (script.in === "") {
      return;
    }

    if (script.type === mode) {
      let outScript2 = script.out.replaceAll("$n", "\n");
      let outScript = outScript2.replace(dreg, "$&");
      let flag = "g";
      if (script.ableFlag) {
        flag = script.flag || "g";
      }
      if (
        outScript.startsWith("@@move_top") ||
        outScript.startsWith("@@move_bottom") ||
        pscript.actions.includes("move_top") ||
        pscript.actions.includes("move_bottom")
      ) {
        flag = flag.replace("g", ""); //temperary fix
      }
      if (outScript.endsWith(">") && !pscript.actions.includes("no_end_nl")) {
        outScript += "\n";
      }
      //remove unsupported flag
      flag = flag.trim().replace(/[^dgimsuvy]/g, "");

      //remove repeated flags
      flag = flag
        .split("")
        .filter((v, i, a) => a.indexOf(v) === i)
        .join("");

      if (flag.length === 0) {
        flag = "u";
      }

      let input = script.in;
      if (pscript.actions.includes("cbs")) {
        input = risuChatParser(input, {
          chatID: chatID,
          cbsConditions,
          chatTarget,
        });
      }

      const reg = compiledRegexCache.get(input, flag);
      if (outScript.startsWith("@@") || pscript.actions.length > 0) {
        reg.lastIndex = 0;
        if (reg.test(data)) {
          reg.lastIndex = 0;
          if (outScript.startsWith("@@emo ")) {
            const emoName = script.out.substring(6).trim();
            let charemotions = get(CharEmotion);
            let tempEmotion = charemotions[char.chaId];
            if (!tempEmotion) {
              tempEmotion = [];
            }
            if (tempEmotion.length > 4) {
              tempEmotion.splice(0, 1);
            }
            if (char.type !== "simple") {
              for (const emo of char.emotionImages) {
                if (emo[0] === emoName) {
                  const emos: [string, string, number] = [
                    emo[0],
                    emo[1],
                    Date.now(),
                  ];
                  tempEmotion.push(emos);
                  charemotions[char.chaId] = tempEmotion;
                  CharEmotion.set(charemotions);
                  emoChanged = true;
                  break;
                }
              }
            }
          } else if (
            (outScript.startsWith("@@inject") ||
              pscript.actions.includes("inject")) &&
            chatID !== -1
          ) {
            const resolvedTarget = chatTarget ? resolveChatTarget(chatTarget) : null;
            const selectedIndex = resolvedTarget?.characterIndex ?? get(selectedCharID);
            const selchar = characterStore.characters[selectedIndex];
            const targetChatIndex = resolvedTarget?.chatIndex ?? selchar.chatPage;
            selchar.chats[targetChatIndex].message[chatID].data = data;
            data = data.replace(reg, "");
          } else if (
            outScript.startsWith("@@move_top") ||
            outScript.startsWith("@@move_bottom") ||
            pscript.actions.includes("move_top") ||
            pscript.actions.includes("move_bottom")
          ) {
            const isGlobal = flag.includes("g");
            reg.lastIndex = 0;
            const matchAll = isGlobal ? data.matchAll(reg) : [data.match(reg)];
            reg.lastIndex = 0;
            data = data.replace(reg, "");
            for (const matched of matchAll) {
              if (matched) {
                const inData = matched[0];
                let out = outScript
                  .replace("@@move_top ", "")
                  .replace("@@move_bottom ", "")
                  .replace(/(?<!\$)\$[0-9]+/g, (v) => {
                    const index = parseInt(v.substring(1));
                    if (index < matched.length) {
                      return matched[index];
                    }
                    return v;
                  })
                  .replace(/\$\&/g, inData)
                  .replace(/(?<!\$)\$<([^>]+)>/g, (v) => {
                    const groupName = parseInt(v.substring(2, v.length - 1));
                    if (matched.groups && matched.groups[groupName]) {
                      return matched.groups[groupName];
                    }
                    return v;
                  });
                if (
                  outScript.startsWith("@@move_top") ||
                  pscript.actions.includes("move_top")
                ) {
                  data = out + "\n" + data;
                } else {
                  data = data + "\n" + out;
                }
              }
            }
          } else {
            data = risuChatParser(data.replace(reg, outScript), {
              chatID: chatID,
              cbsConditions,
              chatTarget,
            });
          }
        } else {
          if (
            (outScript.startsWith("@@repeat_back") ||
              pscript.actions.includes("repeat_back")) &&
            chatID !== -1
          ) {
            const v = outScript.split(" ", 2)[1];
            const resolvedTarget = chatTarget ? resolveChatTarget(chatTarget) : null;
            const selectedIndex = resolvedTarget?.characterIndex ?? get(selectedCharID);
            const selchar = characterStore.characters[selectedIndex];
            const chat = selchar.chats[resolvedTarget?.chatIndex ?? selchar.chatPage];
            let lastChat =
              chat.fmIndex === -1
                ? selchar.firstMessage
                : selchar.alternateGreetings[chat.fmIndex];
            let pointer = chatID - 1;
            while (pointer >= 0) {
              if (chat.message[pointer].role === chat.message[chatID].role) {
                lastChat = chat.message[pointer].data;
                break;
              }
              pointer--;
            }

            reg.lastIndex = 0;
            const r = lastChat.match(reg);
            if (!v) {
              data = data + r[0];
            } else if (r[0]) {
              switch (v) {
                case "end":
                  data = data + r[0];
                  break;
                case "start":
                  data = r[0] + data;
                  break;
                case "end_nl":
                  data = data + "\n" + r[0];
                  break;
                case "start_nl":
                  data = r[0] + "\n" + data;
                  break;
              }
            }
          }
        }
      } else {
        reg.lastIndex = 0;
        data = risuChatParser(data.replace(reg, outScript), {
          chatID: chatID,
          cbsConditions,
          chatTarget,
        });
      }
    }
  }

  let parsedScripts: pScript[] = [];
  let orderChanged = false;
  for (const script of scripts) {
    if (script.ableFlag && script.flag?.includes("<")) {
      const rregex = /<(.+?)>/g;
      const scriptData = safeStructuredClone(script);
      let order = 0;
      const actions: string[] = [];
      scriptData.flag = scriptData.flag?.replace(
        rregex,
        (v: string, p1: string) => {
          const meta = p1.split(",").map((v) => v.trim());
          for (const m of meta) {
            if (m.startsWith("order ")) {
              order = parseInt(m.substring(6));
              orderChanged = true;
            } else {
              actions.push(m);
            }
          }

          return "";
        },
      );
      parsedScripts.push({
        script: scriptData,
        order,
        actions,
      });
      continue;
    }
    parsedScripts.push({
      script,
      order: 0,
      actions: [],
    });
  }

  if (orderChanged) {
    parsedScripts.sort((a, b) => b.order - a.order); //sort by order
  }
  for (const script of parsedScripts) {
    try {
      executeScript(script);
    } catch (error) {
      console.error(error);
    }
  }

  if (
    db.dynamicAssets &&
    (char.type === "simple" || char.type === "character") &&
    char.additionalAssets &&
    char.additionalAssets.length > 0
  ) {
    if (
      (!db.dynamicAssetsEditDisplay && mode === "editdisplay") ||
      mode === "editinput" ||
      mode === "editprocess"
    ) {
      cacheScript(hash, data);
      return { data, emoChanged };
    }
    const assetNames = char.additionalAssets.map((v) => v[0]);

    const moduleAssets = getModuleAssets(moduleRoom, undefined, resolvedTarget?.chat);
    if (moduleAssets.length > 0) {
      for (const asset of moduleAssets) {
        assetNames.push(asset[0]);
      }
    }

    const assetNameSet = new Set(assetNames);
    let processer: HypaProcesser | null = null;
    const getAssetProcesser = async () => {
      if (processer) return processer;
      processer = new HypaProcesser(
        "auto",
        undefined,
        char.chaId ? `dynamic-assets:${char.chaId}` : undefined,
      );
      const serverReady = await processer.prepareServerTextIndex(assetNames);
      if (!serverReady) {
        await processer.addText(assetNames);
      }
      return processer;
    };
    const matches = data.matchAll(assetRegex);

    for (const match of matches) {
      const type = match[1];
      const assetName = match[2];
      const cacheKey = char.chaId + "::" + assetName;
      if (type !== "emotion" && type !== "source") {
        if (bestMatchCache.has(cacheKey)) {
          data = data.replaceAll(
            match[0],
            `{{${type}::${bestMatchCache.get(cacheKey)}}}`,
          );
        } else if (!assetNameSet.has(assetName)) {
          const searched = await (await getAssetProcesser()).similaritySearch(assetName, 1);
          const bestMatch = searched[0];
          if (bestMatch) {
            data = data.replaceAll(match[0], `{{${type}::${bestMatch}}}`);
            bestMatchCache.set(cacheKey, bestMatch);
            if (bestMatchCache.size > 128) {
              bestMatchCache.delete(bestMatchCache.keys().next().value!);
            }
          }
        }
      }
    }
  }

  cacheScript(hash, data);

  return { data, emoChanged };
}

const rgx = /(?:{{|<)(.+?)(?:}}|>)/gm;
export const risuChatParser = risuChatParserOrg;
