import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { executeChatRequestFallbacks } from "@risuai/chat-core/requestLoop.cjs";
import { risuEscape, risuUnescape } from "../../parser/parser.svelte";
import { pluginV2 } from "../../plugins/plugins.svelte";
import { safeStructuredClone } from "../../polyfill";

import { sleep } from "../../util";
import { characterStore } from "../../stores/domain/characterStore.svelte";
import { getTools } from "../mcp/mcp";
import { runTrigger } from "../triggers";
import { requestChatDataMain } from "./request";
import type {
  requestDataArgument,
  requestDataResponse,
} from "./requestContracts";
import type { ModelModeExtended } from "./shared";
import { resolveChatTarget } from "../../chatTarget";

export async function requestChatData(
  arg: requestDataArgument,
  model: ModelModeExtended,
  abortSignal: AbortSignal = null,
): Promise<requestDataResponse> {
  const db = settingsStore.state;
  const fallBackModels: string[] = safeStructuredClone(
    presetStore.state.fallbackModels?.[model] ?? [],
  );
  const requestCharacter = arg.currentChar ?? characterStore.currentCharacter;
  const tools = arg.tools ?? (await getTools(requestCharacter));
  fallBackModels.push("");

  if (arg.escape) {
    arg.useStreaming = false;
    console.warn("Escape is enabled, disabling streaming");
  }

  const originalFormated = safeStructuredClone(arg.formated).map((message) => {
    message.content = risuUnescape(message.content);
    return message;
  });

  return executeChatRequestFallbacks(
    {
      fallbackModels: fallBackModels,
      requestRetries: db.requestRetrys,
      antiServerOverloads: db.antiServerOverloads,
      fallbackWhenBlankResponse: presetStore.state.fallbackWhenBlankResponse,
      bannedCharacterSets: db.banCharacterset,
    },
    {
      beginFallback: () => {
        arg.formated = safeStructuredClone(originalFormated);
      },
      isAborted: () => Boolean(abortSignal?.aborted),
      sleep: async (delayMs) => {
        await sleep(delayMs);
      },
      executeAttempt: async ({ fallbackModel }) => {
        if (pluginV2.replacerbeforeRequest.size > 0) {
          for (const replacer of pluginV2.replacerbeforeRequest) {
            arg.formated = await replacer(arg.formated, model);
          }
        }

        try {
          const currentChar = requestCharacter;
          const triggerChat = arg.triggerTarget
            ? resolveChatTarget(arg.triggerTarget)?.chat
            : characterStore.currentChat;
          if (currentChar?.type !== "group" && triggerChat) {
            const perf = performance.now();
            const triggerResult = await runTrigger(currentChar, "request", {
              chat: triggerChat,
              target: arg.triggerTarget,
              displayMode: true,
              displayData: JSON.stringify(arg.formated),
            });

            const formated = JSON.parse(
              triggerResult?.displayData ?? JSON.stringify(arg.formated),
            );
            if (!formated || !Array.isArray(formated)) {
              throw new Error("Invalid return");
            }
            arg.formated = formated;
            console.log("Trigger time", performance.now() - perf);
          }
        } catch (error) {
          console.error(error);
        }

        const response = await requestChatDataMain(
          {
            ...arg,
            staticModel: fallbackModel || arg.staticModel,
            tools,
          },
          model,
          abortSignal,
        );

        if (response.type === "success" && arg.escape) {
          response.result = risuEscape(response.result);
        }

        if (
          response.type === "success" &&
          pluginV2.replacerafterRequest.size > 0
        ) {
          for (const replacer of pluginV2.replacerafterRequest) {
            response.result = await replacer(response.result, model);
          }
        }

        return response;
      },
    },
  );
}
