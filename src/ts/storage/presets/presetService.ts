import { normalizePromptTemplate } from "./promptTemplateNormalization";
export { normalizePromptTemplate } from "./promptTemplateNormalization";
import { decryptBuffer, encryptBuffer, selectSingleFile } from "../../util";
import { language } from "../../../lang";
import { alertNormal } from "../../alert";
import { prebuiltPresets } from "../../process/templates/templates";
import { safeStructuredClone } from "../../polyfill";
import { settingsStore } from "../../stores/domain/settingsStore.svelte";
import { presetStore } from "../../stores/domain/presetStore.svelte";
import {
  encode as encodeMsgpack,
  decode as decodeMsgpack,
} from "msgpackr/index-no-eval";
import * as fflate from "fflate";
import { decodeRPack, encodeRPack } from "../../rpack/rpack_js";
import type { botPreset } from "../database/schema";
import { presetTemplate } from "./presetDefaults";
import type { PresetApplyPolicy } from "./presetState";
export {
  createActivePresetSnapshot,
  createPresetSettingsState,
} from "./presetState";

export async function copyPreset(id: number) {
  await presetStore.flush();
  const source = await presetStore.load(presetStore.summaries[id].id);
  const newPres = safeStructuredClone(source);
  delete (newPres as any).id;
  newPres.name += " Copy";
  await presetStore.savePreset(newPres, presetStore.summaries.length);
}

export function getPresetApplyPolicy(): PresetApplyPolicy {
  const settings = settingsStore.state;
  return {
    doNotChangeSeperateModels: settings.doNotChangeSeperateModels ?? false,
    doNotChangeFallbackModels: settings.doNotChangeFallbackModels ?? false,
    disableSeperateParameterChangeOnPresetChange:
      settings.disableSeperateParameterChangeOnPresetChange ?? false,
  };
}

export async function changeToPreset(id = 0) {
  const summary = presetStore.summaries[id];
  if (summary) await presetStore.activate(summary.id, getPresetApplyPolicy());
}

export function applyPresetToCurrentState(preset: botPreset): void {
  presetStore.applyPreset(preset, getPresetApplyPolicy());
}

export async function downloadPreset(
  id: number,
  type: "json" | "risupreset" | "return" = "json",
) {
  await presetStore.flush();
  let pres = safeStructuredClone(
    await presetStore.load(presetStore.summaries[id].id),
  );
  delete (pres as any).id;
  pres.openAIKey = "";
  pres.forceReplaceUrl = "";
  pres.forceReplaceUrl2 = "";
  pres.proxyKey = "";
  pres.textgenWebUIStreamURL = "";
  pres.textgenWebUIBlockingURL = "";

  if (type === "json") {
    const { downloadFile } = await import("../../globalApi.svelte");
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
      const { downloadFile } = await import("../../globalApi.svelte");
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
      ...JSON.parse(new TextDecoder().decode(f.data)),
    };
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

    const promptById = new Map<any, any>();
    for (const p of pre.prompts) {
      if (p && p.identifier !== undefined) {
        promptById.set(p.identifier, p);
      }
    }
    pr.temperature = (pre.temperature ?? 0.8) * 100;
    pr.frequencyPenalty = (pre.frequency_penalty ?? 0.7) * 100;
    pr.PresensePenalty = pre.presence_penalty * 0.7 * 100;
    pr.top_p = pre.top_p ?? 1;

    for (const prompt of pre.prompt_order[0].order) {
      if (!prompt?.enabled) {
        continue;
      }
      const p = promptById.get(prompt?.identifier ?? "");
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
