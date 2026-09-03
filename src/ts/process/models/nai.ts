import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";

import { getUserName } from "src/ts/util";
import type { OpenAIChat } from "@risuai/chat-core/types.cjs";

export function stringlizeNAIChat(
  formated: OpenAIChat[],
  char: string,
  continued: boolean,
) {
  const db = settingsStore.state;
  let seperator =
    presetStore.state.NAIsettings.seperator.replaceAll("\\n", "\n") || "\n";
  let starter =
    presetStore.state.NAIsettings.starter.replaceAll("\\n", "\n") || "⁂";
  let resultString: string[] = [];

  for (const form of formated) {
    if (form.role === "system") {
      if (
        form.memo === "NewChatExample" ||
        form.memo === "NewChat" ||
        form.content === "[Start a new chat]"
      ) {
        resultString.push(starter);
      } else {
        resultString.push(form.content);
      }
    } else if (form.name || form.role === "assistant") {
      if (!presetStore.state.NAIappendName) {
        resultString.push(form.content);
      } else {
        resultString.push((form.name ?? char) + ": " + form.content);
      }
    } else if (form.role === "user") {
      let res = "";
      if (presetStore.state.NAIadventure) {
        res += "> ";
      }
      if (presetStore.state.NAIappendName) {
        res += getUserName() + ": ";
      }
      res += form.content;
      resultString.push(res);
    } else {
      resultString.push(form.content);
    }
  }

  let res = resultString.join(seperator);

  if (!continued) {
    res += `${seperator}${char}:`;
  }
  console.log(res);
  return res;
}

export interface NAISettings {
  topK: number;
  topP: number;
  topA: number;
  tailFreeSampling: number;
  repetitionPenalty: number;
  repetitionPenaltyRange: number;
  repetitionPenaltySlope: number;
  repostitionPenaltyPresence: number;
  seperator: string;
  frequencyPenalty: number;
  presencePenalty: number;
  typicalp: number;
  starter: string;
  mirostat_lr?: number;
  mirostat_tau?: number;
  cfg_scale?: number;
}

export { NOVELAI_BAD_WORD_IDS as NovelAIBadWordIds } from "@risuai/chat-core/novelAIProvider.cjs";
