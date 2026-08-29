import { defaultJailbreak, defaultMainPrompt } from "../defaultPrompts";
import { safeStructuredClone } from "../../polyfill";
import type { Database, PortableDatabase } from "../schema";
import { presetTemplate } from "../presetDefaults";
import { normalizePromptTemplate } from "../presetService";

export function normalizeCoreDatabaseSettings(data: Database): void {
  data.characters ??= [];
  data.apiType ??= "gemini-3-flash-preview";
  data.openAIKey ??= "";
  data.mainPrompt ??= defaultMainPrompt;
  data.jailbreak ??= defaultJailbreak;
  data.globalNote ??= ``;
  data.temperature ??= 80;
  data.maxContext ??= 4000;
  data.maxResponse ??= 500;
  data.frequencyPenalty ??= 70;
  data.PresensePenalty ??= 70;
  data.aiModel ??= "gemini-3-flash-preview";
  data.jailbreakToggle ??= false;
  data.formatingOrder ??= [
    "main",
    "description",
    "personaPrompt",
    "chats",
    "lastChat",
    "jailbreak",
    "lorebook",
    "globalNote",
    "authorNote",
  ];
  data.loreBookDepth ??= 5;
  data.loreBookToken ??= 800;
  data.username ??= "User";
  data.userIcon ??= "";
  data.userNote ??= "";
  data.additionalPrompt ??=
    "The assistant must act as {{char}}. user is {{user}}.";
  data.descriptionPrefix ??= "description of {{char}}: ";
  data.forceReplaceUrl ??= "";
  data.language ??= "en";
  data.swipe ??= true;
  data.translator ??= "";
  data.translatorMaxResponse ??= 1000;
  data.currentPluginProvider ??= "";
  data.plugins ??= [];
  data.pluginCustomStorage ??= {};
  data.zoomsize ??= 100;
  data.customBackground ??= "";
  data.textgenWebUIStreamURL ??= "wss://localhost/api/";
  data.textgenWebUIBlockingURL ??= "https://localhost/api/";
  data.autoTranslate ??= false;
  data.fullScreen ??= false;
  data.playMessage ??= false;
  data.iconsize ??= 100;
  data.theme ??= "";
  data.subModel ??= "gemini-3-flash-preview";
  data.waifuWidth ??= 100;
  data.waifuWidth2 ??= 100;
  data.emotionPrompt ??= "";
  data.proxyKey ??= "";
  const portableData = data as Database & Partial<PortableDatabase>;
  portableData.botPresets ??= [
    {
      ...safeStructuredClone(presetTemplate),
      name: "Default",
    },
  ];
  portableData.botPresetsId ??= 0;
  if (Array.isArray(data.promptTemplate)) {
    data.promptTemplate = normalizePromptTemplate(data.promptTemplate);
  } else {
    data.promptTemplate = [];
  }
}
