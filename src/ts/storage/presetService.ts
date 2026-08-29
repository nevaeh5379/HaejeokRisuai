import { decryptBuffer, encryptBuffer, selectSingleFile } from "../util";
import { language } from "../../lang";
import { alertNormal } from "../alert";
import { prebuiltPresets } from "../process/templates/templates";
import type { PromptItem } from "../process/prompt";
import { safeStructuredClone } from "../polyfill";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { presetStore } from "../stores/domain/presetStore.svelte";
import { encode as encodeMsgpack, decode as decodeMsgpack } from "msgpackr/index-no-eval";
import * as fflate from "fflate";
import { decodeRPack, encodeRPack } from "../rpack/rpack_js";
import type { DatabaseSettings, botPreset } from "./schema";
import type { StoredBotPreset } from "./ISqlStorage";
import { presetTemplate } from "./presetDefaults";
import { LLMFormat } from "../model/types";

export function createActivePresetSnapshot(
  db: DatabaseSettings,
  current: Pick<StoredBotPreset, "id" | "name" | "image">,
): StoredBotPreset {
  const savedPreset: botPreset = {
    name: current.name,
    apiType: db.apiType,
    openAIKey: db.openAIKey,
    localNetworkMode: db.localNetworkMode,
    localNetworkTimeoutSec: db.localNetworkTimeoutSec,
    mainPrompt: db.mainPrompt,
    jailbreak: db.jailbreak,
    globalNote: db.globalNote,
    temperature: db.temperature,
    maxContext: db.maxContext,
    maxResponse: db.maxResponse,
    frequencyPenalty: db.frequencyPenalty,
    PresensePenalty: db.PresensePenalty,
    formatingOrder: db.formatingOrder,
    aiModel: db.aiModel,
    subModel: db.subModel,
    currentPluginProvider: db.currentPluginProvider,
    textgenWebUIStreamURL: db.textgenWebUIStreamURL,
    textgenWebUIBlockingURL: db.textgenWebUIBlockingURL,
    forceReplaceUrl: db.forceReplaceUrl,
    promptPreprocess: db.promptPreprocess,
    bias: db.bias,
    koboldURL: db.koboldURL,
    proxyKey: db.proxyKey,
    ooba: safeStructuredClone(db.ooba),
    ainconfig: safeStructuredClone(db.ainconfig),
    proxyRequestModel: db.proxyRequestModel,
    openrouterRequestModel: db.openrouterRequestModel,
    openrouterSubRequestModel: db.openrouterSubRequestModel,
    NAISettings: safeStructuredClone(db.NAIsettings),
    promptTemplate: normalizePromptTemplate(db.promptTemplate) ?? null,
    NAIadventure: db.NAIadventure ?? false,
    NAIappendName: db.NAIappendName ?? false,
    localStopStrings: db.localStopStrings,
    autoSuggestPrompt: db.autoSuggestPrompt,
    customProxyRequestModel: db.customProxyRequestModel,
    customProxySubRequestModel: db.customProxySubRequestModel,
    reverseProxyOobaArgs: safeStructuredClone(db.reverseProxyOobaArgs) ?? null,
    top_p: db.top_p ?? 1,
    promptSettings: safeStructuredClone(db.promptSettings) ?? null,
    repetition_penalty: db.repetition_penalty,
    min_p: db.min_p,
    top_a: db.top_a,
    openrouterProvider: db.openrouterProvider,
    useInstructPrompt: db.useInstructPrompt,
    customPromptTemplateToggle: db.customPromptTemplateToggle ?? "",
    templateDefaultVariables: db.templateDefaultVariables ?? "",
    moduleIntergration: db.moduleIntergration ?? "",
    top_k: db.top_k,
    instructChatTemplate: db.instructChatTemplate,
    JinjaTemplate: db.JinjaTemplate ?? "",
    jsonSchemaEnabled: db.jsonSchemaEnabled ?? false,
    jsonSchema: db.jsonSchema ?? "",
    strictJsonSchema: db.strictJsonSchema ?? true,
    extractJson: db.extractJson ?? "",
    groupOtherBotRole: db.groupOtherBotRole ?? "user",
    groupTemplate: db.groupTemplate ?? "",
    seperateParametersEnabled: db.seperateParametersEnabled ?? false,
    seperateParameters: safeStructuredClone(db.seperateParameters),
    customAPIFormat: safeStructuredClone(db.customAPIFormat),
    systemContentReplacement: db.systemContentReplacement,
    systemRoleReplacement: db.systemRoleReplacement,
    customFlags: safeStructuredClone(db.customFlags),
    enableCustomFlags: db.enableCustomFlags,
    regex: db.presetRegex,
    image: current.image ?? "",
    reasonEffort: db.reasoningEffort ?? 0,
    thinkingTokens: db.thinkingTokens ?? null,
    thinkingType: db.thinkingType ?? "budget",
    deepseekThinkingType: db.deepseekThinkingType ?? "off",
    adaptiveThinkingEffort: db.adaptiveThinkingEffort ?? "high",
    deepseekReasoningEffort: db.deepseekReasoningEffort ?? "high",
    outputImageModal: db.outputImageModal ?? false,
    seperateModelsForAxModels: db.doNotChangeSeperateModels
      ? false
      : (db.seperateModelsForAxModels ?? false),
    seperateModels: db.doNotChangeSeperateModels
      ? null
      : safeStructuredClone(db.seperateModels),
    modelTools: safeStructuredClone(db.modelTools),
    fallbackModels: safeStructuredClone(db.fallbackModels),
    fallbackWhenBlankResponse: db.fallbackWhenBlankResponse ?? false,
    verbosity: db.verbosity ?? 1,
    dynamicOutput: db.dynamicOutput ?? null,
  };

  return { ...savedPreset, id: current.id } as StoredBotPreset;
}

export async function saveCurrentPreset() {
  const current = presetStore.activePresetMetadata;
  if (!current) return;
  await presetStore.savePreset(
    createActivePresetSnapshot(settingsStore.state, current),
  );
}

export async function copyPreset(id: number) {
  await saveCurrentPreset();
  const source = await presetStore.load(presetStore.summaries[id].id);
  const newPres = safeStructuredClone(source);
  delete (newPres as any).id;
  newPres.name += " Copy";
  await presetStore.savePreset(newPres, presetStore.summaries.length);
}

export async function changeToPreset(id = 0, savecurrent = true) {
  if (savecurrent) {
    await saveCurrentPreset();
  }
  const db = settingsStore.state;
  const summary = presetStore.summaries[id];
  if (!summary) return;
  const newPres = await presetStore.load(summary.id);
  await presetStore.setActiveId(summary.id);
  setPreset(db, newPres);
}

export function setPreset(db: DatabaseSettings, newPres: botPreset) {
  db.apiType = newPres.apiType ?? db.apiType;
  db.localNetworkMode = newPres.localNetworkMode ?? db.localNetworkMode;
  db.localNetworkTimeoutSec =
    newPres.localNetworkTimeoutSec ?? db.localNetworkTimeoutSec;
  db.mainPrompt = newPres.mainPrompt ?? db.mainPrompt;
  db.jailbreak = newPres.jailbreak ?? db.jailbreak;
  db.globalNote = newPres.globalNote ?? db.globalNote;
  db.temperature = newPres.temperature ?? db.temperature;
  db.maxContext = newPres.maxContext ?? db.maxContext;
  db.maxResponse = newPres.maxResponse ?? db.maxResponse;
  db.frequencyPenalty = newPres.frequencyPenalty ?? db.frequencyPenalty;
  db.PresensePenalty = newPres.PresensePenalty ?? db.PresensePenalty;
  db.formatingOrder = newPres.formatingOrder ?? db.formatingOrder;
  db.aiModel = newPres.aiModel ?? db.aiModel;
  db.subModel = newPres.subModel ?? db.subModel;
  db.currentPluginProvider =
    newPres.currentPluginProvider ?? db.currentPluginProvider;
  db.textgenWebUIStreamURL =
    newPres.textgenWebUIStreamURL ?? db.textgenWebUIStreamURL;
  db.textgenWebUIBlockingURL =
    newPres.textgenWebUIBlockingURL ?? db.textgenWebUIBlockingURL;
  db.forceReplaceUrl = newPres.forceReplaceUrl ?? db.forceReplaceUrl;
  db.promptPreprocess = newPres.promptPreprocess ?? db.promptPreprocess;
  db.bias = newPres.bias ?? db.bias;
  db.koboldURL = newPres.koboldURL ?? db.koboldURL;
  db.proxyKey = newPres.proxyKey ?? db.proxyKey;
  db.ooba = safeStructuredClone(newPres.ooba ?? db.ooba);
  db.ainconfig = safeStructuredClone(newPres.ainconfig ?? db.ainconfig);
  db.openrouterRequestModel =
    newPres.openrouterRequestModel ?? db.openrouterRequestModel;
  db.openrouterSubRequestModel =
    newPres.openrouterSubRequestModel ??
    newPres.openrouterRequestModel ??
    db.openrouterSubRequestModel;
  db.proxyRequestModel = newPres.proxyRequestModel ?? db.proxyRequestModel;
  db.NAIsettings = newPres.NAISettings ?? db.NAIsettings;
  db.autoSuggestPrompt = newPres.autoSuggestPrompt ?? db.autoSuggestPrompt;
  db.autoSuggestPrefix = newPres.autoSuggestPrefix ?? db.autoSuggestPrefix;
  db.autoSuggestClean = newPres.autoSuggestClean ?? db.autoSuggestClean;
  db.promptTemplate = normalizePromptTemplate(newPres.promptTemplate);
  db.NAIadventure = newPres.NAIadventure;
  db.NAIappendName = newPres.NAIappendName;
  db.NAIsettings.cfg_scale ??= 1;
  db.NAIsettings.mirostat_tau ??= 0;
  db.NAIsettings.mirostat_lr ??= 1;
  db.localStopStrings = newPres.localStopStrings;
  db.customProxyRequestModel = newPres.customProxyRequestModel ?? "";
  db.customProxySubRequestModel =
    newPres.customProxySubRequestModel ??
    newPres.customProxyRequestModel ??
    db.customProxyRequestModel;
  db.reverseProxyOobaArgs = safeStructuredClone(
    newPres.reverseProxyOobaArgs,
  ) ?? {
    mode: "instruct",
  };
  db.top_p = newPres.top_p ?? 1;
  db.promptSettings = safeStructuredClone(newPres.promptSettings) ?? {
    assistantPrefill: "",
    postEndInnerFormat: "",
    sendChatAsSystem: false,
    sendName: false,
    utilOverride: false,
  };
  db.promptSettings.maxThoughtTagDepth ??= -1;
  db.repetition_penalty = newPres.repetition_penalty;
  db.min_p = newPres.min_p;
  db.top_a = newPres.top_a;
  db.openrouterProvider = newPres.openrouterProvider;
  db.useInstructPrompt = newPres.useInstructPrompt ?? false;
  db.customPromptTemplateToggle = newPres.customPromptTemplateToggle ?? "";
  db.templateDefaultVariables = newPres.templateDefaultVariables ?? "";
  db.moduleIntergration = newPres.moduleIntergration ?? "";
  db.top_k = newPres.top_k ?? db.top_k;
  db.instructChatTemplate =
    newPres.instructChatTemplate ?? db.instructChatTemplate;
  db.JinjaTemplate = newPres.JinjaTemplate ?? db.JinjaTemplate;
  db.jsonSchemaEnabled = newPres.jsonSchemaEnabled ?? false;
  db.jsonSchema = newPres.jsonSchema ?? "";
  db.strictJsonSchema = newPres.strictJsonSchema ?? true;
  db.extractJson = newPres.extractJson ?? "";
  db.groupOtherBotRole = newPres.groupOtherBotRole ?? "user";
  db.groupTemplate = newPres.groupTemplate ?? "";
  db.seperateParametersEnabled = newPres.seperateParametersEnabled ?? false;
  db.customAPIFormat =
    safeStructuredClone(newPres.customAPIFormat) ?? LLMFormat.OpenAICompatible;
  db.systemContentReplacement = newPres.systemContentReplacement ?? "";
  db.systemRoleReplacement = newPres.systemRoleReplacement ?? "user";
  db.customFlags = safeStructuredClone(newPres.customFlags) ?? [];
  db.enableCustomFlags = newPres.enableCustomFlags ?? false;
  db.presetRegex = newPres.regex ?? [];
  db.reasoningEffort = newPres.reasonEffort ?? 0;
  db.thinkingTokens = newPres.thinkingTokens ?? null;
  db.thinkingType = newPres.thinkingType ?? "budget";
  db.deepseekThinkingType = newPres.deepseekThinkingType ?? "off";
  db.adaptiveThinkingEffort = newPres.adaptiveThinkingEffort ?? "high";
  db.deepseekReasoningEffort = newPres.deepseekReasoningEffort ?? "high";
  db.outputImageModal = newPres.outputImageModal ?? false;
  if (!db.doNotChangeSeperateModels) {
    db.seperateModelsForAxModels = newPres.seperateModelsForAxModels ?? false;
    db.seperateModels = safeStructuredClone(newPres.seperateModels) ?? {
      memory: "",
      emotion: "",
      translate: "",
      otherAx: "",
    };
  }
  if (!db.doNotChangeFallbackModels) {
    db.fallbackModels = safeStructuredClone(newPres.fallbackModels) ?? {
      memory: [],
      emotion: [],
      translate: [],
      otherAx: [],
      model: [],
    };
    db.fallbackWhenBlankResponse = newPres.fallbackWhenBlankResponse ?? false;
  }
  if (db.disableSeperateParameterChangeOnPresetChange) {
    db.seperateParameters = safeStructuredClone(db.seperateParameters);
  } else {
    db.seperateParameters = newPres.seperateParameters
      ? safeStructuredClone(newPres.seperateParameters)
      : {
          memory: {},
          emotion: {},
          translate: {},
          otherAx: {},
          overrides: {},
        };
  }
  db.modelTools = safeStructuredClone(newPres.modelTools ?? []);
  db.verbosity = newPres.verbosity ?? 1;
  db.dynamicOutput = newPres.dynamicOutput;

  return db;
}

export async function downloadPreset(
  id: number,
  type: "json" | "risupreset" | "return" = "json",
) {
  await saveCurrentPreset();
  let pres = safeStructuredClone(
    await presetStore.load(presetStore.summaries[id].id),
  );
  delete (pres as any).id;
  console.log(pres);
  pres.openAIKey = "";
  pres.forceReplaceUrl = "";
  pres.forceReplaceUrl2 = "";
  pres.proxyKey = "";
  pres.textgenWebUIStreamURL = "";
  pres.textgenWebUIBlockingURL = "";

  if (type === "json") {
    const { downloadFile } = await import("../globalApi.svelte");
    await downloadFile(
      pres.name + "_preset.json",
      Buffer.from(JSON.stringify(pres, null, 2)),
    );
  } else if (type === "risupreset" || type === "return") {
    const buf = fflate.compressSync(
      encodeMsgpack({
        presetVersion: 2,
        type: "preset",
        preset: await encryptBuffer(encodeMsgpack(pres), "risupreset"),
      }),
    );

    const buf2 = await encodeRPack(buf);

    if (type === "risupreset") {
      const { downloadFile } = await import("../globalApi.svelte");
      await downloadFile(pres.name + "_preset.risup", buf2);
    } else {
      return {
        data: pres,
        buf: buf2,
      };
    }
  }

  alertNormal(language.successExport);

  return {
    data: pres,
    buf: null,
  };
}

export async function importPreset(
  f: {
    name: string;
    data: Uint8Array;
  } | null = null,
) {
  if (!f) {
    f = await selectSingleFile(["json", "preset", "risupreset", "risup"]);
  }
  if (!f) {
    return;
  }
  let pre: any;
  if (f.name.endsWith(".risupreset") || f.name.endsWith(".risup")) {
    let data = f.data;
    if (f.name.endsWith(".risup")) {
      data = await decodeRPack(data);
    }
    const decoded = await decodeMsgpack(fflate.decompressSync(data));
    console.log(decoded);
    if (
      (decoded.presetVersion === 0 || decoded.presetVersion === 2) &&
      decoded.type === "preset"
    ) {
      pre = {
        ...presetTemplate,
        ...decodeMsgpack(
          Buffer.from(
            await decryptBuffer(decoded.preset ?? decoded.pres, "risupreset"),
          ),
        ),
      };
    }
  } else {
    pre = {
      ...presetTemplate,
      ...JSON.parse(Buffer.from(f.data).toString("utf-8")),
    };
    console.log(pre);
  }
  if (pre?.promptTemplate !== undefined) {
    pre.promptTemplate = normalizePromptTemplate(pre.promptTemplate);
  }
  if (pre.presetVersion && pre.presetVersion >= 3) {
    //NAI preset
    const pr = safeStructuredClone(prebuiltPresets.NAI);
    pr.temperature = pre.parameters.temperature * 100;
    pr.maxResponse = pre.parameters.max_length;
    pr.NAISettings.topK = pre.parameters.top_k;
    pr.NAISettings.topP = pre.parameters.top_p;
    pr.NAISettings.topA = pre.parameters.top_a;
    pr.NAISettings.typicalp = pre.parameters.typical_p;
    pr.NAISettings.tailFreeSampling = pre.parameters.tail_free_sampling;
    pr.NAISettings.repetitionPenalty = pre.parameters.repetition_penalty;
    pr.NAISettings.repetitionPenaltyRange =
      pre.parameters.repetition_penalty_range;
    pr.NAISettings.repetitionPenaltySlope =
      pre.parameters.repetition_penalty_slope;
    pr.NAISettings.frequencyPenalty =
      pre.parameters.repetition_penalty_frequency;
    pr.NAISettings.repostitionPenaltyPresence =
      pre.parameters.repetition_penalty_presence;
    pr.PresensePenalty = pre.parameters.repetition_penalty_presence * 100;
    pr.NAISettings.cfg_scale = pre.parameters.cfg_scale;
    pr.NAISettings.mirostat_lr = pre.parameters.mirostat_lr;
    pr.NAISettings.mirostat_tau = pre.parameters.mirostat_tau;
    pr.name = pre.name ?? "Imported";
    await presetStore.savePreset(pr, presetStore.summaries.length);
    return;
  }

  if (
    Array.isArray(pre?.prompt_order?.[0]?.order) &&
    Array.isArray(pre?.prompts)
  ) {
    //ST preset
    const pr = safeStructuredClone(presetTemplate);
    pr.promptTemplate = [];

    function findPrompt(identifier: number) {
      return pre.prompts.find((p: any) => p.identifier === identifier);
    }
    pr.temperature = (pre.temperature ?? 0.8) * 100;
    pr.frequencyPenalty = (pre.frequency_penalty ?? 0.7) * 100;
    pr.PresensePenalty = pre.presence_penalty * 0.7 * 100;
    pr.top_p = pre.top_p ?? 1;

    for (const prompt of pre.prompt_order[0].order) {
      if (!prompt?.enabled) {
        continue;
      }
      const p = findPrompt(prompt?.identifier ?? "");
      if (p) {
        switch (p.identifier) {
          case "main": {
            pr.promptTemplate.push({
              type: "plain",
              type2: "main",
              text: p.content ?? "",
              role: p.role ?? "system",
            });
            break;
          }
          case "jailbreak":
          case "nsfw": {
            pr.promptTemplate.push({
              type: "jailbreak",
              type2: "normal",
              text: p.content ?? "",
              role: p.role ?? "system",
            });
            break;
          }
          case "dialogueExamples":
          case "charPersonality":
          case "scenario": {
            break; //ignore
          }
          case "chatHistory": {
            pr.promptTemplate.push({
              type: "chat",
              rangeEnd: "end",
              rangeStart: 0,
            });
            break;
          }
          case "worldInfoBefore": {
            pr.promptTemplate.push({
              type: "lorebook",
            });
            break;
          }
          case "worldInfoAfter": {
            break;
          }
          case "charDescription": {
            pr.promptTemplate.push({
              type: "description",
            });
            break;
          }
          case "personaDescription": {
            pr.promptTemplate.push({
              type: "persona",
            });
            break;
          }
          default: {
            console.log(p);
            pr.promptTemplate.push({
              type: "plain",
              type2: "normal",
              text: p.content ?? "",
              role: p.role ?? "system",
            });
          }
        }
      } else {
        console.log("Prompt not found", prompt);
      }
    }
    if (pre?.assistant_prefill) {
      pr.promptTemplate.push({
        type: "postEverything",
      });
      pr.promptTemplate.push({
        type: "plain",
        type2: "main",
        text: `{{#if {{prefill_supported}}}}${pre?.assistant_prefill}{{/if}}`,
        role: "bot",
      });
    }
    pr.promptTemplate = normalizePromptTemplate(pr.promptTemplate);
    pr.name = "Imported ST Preset";
    await presetStore.savePreset(pr, presetStore.summaries.length);
    return;
  }
  pre.name ??= "Imported";
  await presetStore.savePreset(pre, presetStore.summaries.length);
}

function normalizePromptRole(role: unknown): "user" | "bot" | "system" | null {
  if (role === "user" || role === "bot" || role === "system") {
    return role;
  }
  if (role === "assistant" || role === "char") {
    return "bot";
  }
  return null;
}

function normalizeCacheRole(
  role: unknown,
): "user" | "assistant" | "system" | "all" {
  if (
    role === "user" ||
    role === "assistant" ||
    role === "system" ||
    role === "all"
  ) {
    return role;
  }
  if (role === "bot" || role === "char") {
    return "assistant";
  }
  return "all";
}

export function normalizePromptTemplate(
  template: PromptItem[] | null | undefined,
): PromptItem[] | null {
  if (!Array.isArray(template)) {
    return null;
  }
  const normalized = safeStructuredClone(template) as any[];
  for (const item of normalized) {
    if (!item || typeof item !== "object") {
      continue;
    }
    switch (item.type) {
      case "plain":
      case "jailbreak":
      case "cot": {
        item.role = normalizePromptRole(item.role) ?? "system";
        break;
      }
      case "persona":
      case "description":
      case "authornote":
      case "memory": {
        if (item.role2 !== undefined && item.role2 !== null) {
          item.role2 = normalizePromptRole(item.role2) ?? "system";
        }
        break;
      }
      case "cache": {
        item.role = normalizeCacheRole(item.role);
        break;
      }
    }
  }
  return normalized as PromptItem[];
}
