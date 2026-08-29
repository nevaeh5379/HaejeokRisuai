import { createHypaV3Preset } from "../../process/memory/hypav3Preset";
import { normalizeTranslatorPresetState } from "../../translator/presets";
import { safeStructuredClone } from "../../polyfill";
import { defaultHotkeys } from "../../defaulthotkeys";
import { LLMFormat } from "../../model/types";
import type { Database } from "../schema";

function normalizeHypaV3Presets(data: Database): void {
  data.hypaV3Presets ??= [
    createHypaV3Preset("Default", {
      summarizationPrompt: data.supaMemoryPrompt || "",
      ...data.hypaV3Settings,
    }),
  ];
  if (data.hypaV3Presets.length > 0) {
    data.hypaV3Presets = data.hypaV3Presets.map((preset, i) =>
      createHypaV3Preset(
        preset.name || `Preset ${i + 1}`,
        preset.settings || {},
      ),
    );
  }
  data.hypaV3PresetId ??= 0;
}

function migrateAntiClaudeOverload(data: Database): void {
  if (!data.antiClaudeOverload) return;
  data.antiClaudeOverload = false;
  data.antiServerOverloads = true;
}

function normalizeHypaCustomSettings(data: Database): void {
  data.hypaCustomSettings = {
    url: data.hypaCustomSettings?.url ?? "",
    key: data.hypaCustomSettings?.key ?? "",
    model: data.hypaCustomSettings?.model ?? "",
  };
}

function normalizeSeparateModels(data: Database): void {
  data.seperateModels ??= {
    memory: "",
    emotion: "",
    translate: "",
    otherAx: "",
  };
  data.seperateModels.memory ??= "";
  data.seperateModels.emotion ??= "";
  data.seperateModels.translate ??= "";
  data.seperateModels.otherAx ??= "";
}

function normalizeHotkeys(data: Database): void {
  if (!data.hotkeys) {
    data.hotkeys = safeStructuredClone(defaultHotkeys);
  } else {
    const existingActions = new Set(data.hotkeys.map((hotkey) => hotkey.action));
    const newHotkeys = defaultHotkeys.filter(
      (hotkey) => !existingActions.has(hotkey.action),
    );
    if (newHotkeys.length > 0) {
      data.hotkeys.push(...safeStructuredClone(newHotkeys));
    }
  }

  if (data.enableScrollToActiveChar === false) {
    data.hotkeys = data.hotkeys.filter(
      (hotkey) => hotkey.action !== "scrollToActiveChar",
    );
  }
}

function normalizeFallbackModels(data: Database): void {
  data.fallbackModels ??= {
    memory: [],
    emotion: [],
    translate: [],
    otherAx: [],
    model: [],
  };
  data.fallbackModels.model ??= [];
  data.fallbackModels.memory ??= [];
  data.fallbackModels.emotion ??= [];
  data.fallbackModels.translate ??= [];
  data.fallbackModels.otherAx ??= [];
  data.fallbackModels = {
    model: data.fallbackModels.model.filter((value) => value !== ""),
    memory: data.fallbackModels.memory.filter((value) => value !== ""),
    emotion: data.fallbackModels.emotion.filter((value) => value !== ""),
    translate: data.fallbackModels.translate.filter((value) => value !== ""),
    otherAx: data.fallbackModels.otherAx.filter((value) => value !== ""),
  };
}

export function normalizeFeatureDatabaseSettings(data: Database): void {
  data.useInstructPrompt ??= false;
  data.hanuraiEnable ??= false;
  data.hanuraiSplit ??= false;
  data.hanuraiTokens ??= 1000;
  data.textAreaSize ??= 0;
  data.sideBarSize ??= 0;
  data.textAreaTextSize ??= 0;
  data.combineTranslation ??= false;
  data.customPromptTemplateToggle ??= "";
  data.globalChatVariables ??= {};
  data.templateDefaultVariables ??= "";
  data.hypaAllocatedTokens ??= 3000;
  data.hypaChunkSize ??= 3000;
  data.dallEQuality ??= "standard";
  data.customTextTheme.FontColorQuote1 ??= "#8BE9FD";
  data.customTextTheme.FontColorQuote2 ??= "#FFB86C";
  data.font ??= "default";
  data.customFont ??= "";
  data.lineHeight ??= 1.25;
  data.stabilityModel ??= "sd3-large";
  data.stabllityStyle ??= "";
  data.legacyTranslation ??= false;
  data.comfyUiUrl ??= "http://localhost:8188";
  data.comfyConfig ??= {
    workflow: "",
    posNodeID: "",
    posInputName: "text",
    negNodeID: "",
    negInputName: "text",
    timeout: 30,
  };
  data.hideApiKey ??= true;
  data.unformatQuotes ??= false;
  data.ttsAutoSpeech ??= false;
  data.autoColorAdapt ??= false;
  data.colorAdaptEngine ??= "oklch";
  data.translatorInputLanguage ??= "auto";
  data.falModel ??= "fal-ai/flux/dev";
  data.falLoraScale ??= 1;
  data.customCSS ??= "";
  data.strictJsonSchema ??= true;
  data.statics ??= {
    messages: 0,
    imports: 0,
  };
  data.customQuotes ??= false;
  data.customQuotesData ??= ["“", "”", "‘", "’"];
  data.groupOtherBotRole ??= "user";
  data.customGUI ??= "";
  data.customAPIFormat ??= LLMFormat.OpenAICompatible;
  data.systemContentReplacement ??= `system: {{slot}}`;
  data.systemRoleReplacement ??= "user";
  data.vertexAccessToken ??= "";
  data.vertexAccessTokenExpires ??= 0;
  data.vertexClientEmail ??= "";
  data.vertexPrivateKey ??= "";
  data.vertexRegion ??= "global";
  data.seperateParametersEnabled ??= false;
  data.seperateParameters ??= {
    memory: {},
    emotion: {},
    translate: {},
    otherAx: {},
    overrides: {},
  };
  data.seperateParameters.memory ??= {};
  data.seperateParameters.emotion ??= {};
  data.seperateParameters.translate ??= {};
  data.seperateParameters.otherAx ??= {};
  data.seperateParameters.overrides ??= {};
  data.customFlags ??= [];
  data.enableCustomFlags ??= false;
  data.assetMaxDifference ??= 4;
  data.showSavingIcon ??= false;
  data.banCharacterset ??= [];
  data.showPromptComparison ??= false;
  data.OaiCompAPIKeys ??= {};
  data.reasoningEffort ??= 0;
  data.verbosity ??= 1;
  normalizeHypaV3Presets(data);
  normalizeTranslatorPresetState(data);
  data.showDeprecatedTriggerV2 ??= false;
  data.returnCSSError ??= true;
  data.realmDirectOpen ??= false;
  data.checkCorruption ??= false;
  data.toggleConfirmRecommendedPreset ??= false;
  data.useExperimentalGoogleTranslator ??= false;
  data.thinkingType ??= "budget";
  data.deepseekThinkingType ??= "off";
  data.adaptiveThinkingEffort ??= "high";
  data.deepseekReasoningEffort ??= "high";
  migrateAntiClaudeOverload(data);
  normalizeHypaCustomSettings(data);
  data.doNotChangeSeperateModels ??= false;
  data.seperateModelsForAxModels ??= false;
  normalizeSeparateModels(data);
  data.modelTools ??= [];
  data.enableScrollToActiveChar ??= true;
  normalizeHotkeys(data);
  normalizeFallbackModels(data);
}
