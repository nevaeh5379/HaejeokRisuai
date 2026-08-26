import { executeChatRequestFallbacks } from "@risuai/chat-core/requestLoop.cjs";
import { risuEscape, risuUnescape } from "../../parser/parser.svelte";
import { pluginV2 } from "../../plugins/plugins.svelte";
import { safeStructuredClone } from "../../polyfill";
import {
  getCurrentCharacter,
  getCurrentChat,
  getDatabase,
} from "../../storage/database.svelte";
import { sleep } from "../../util";
import { getTools } from "../mcp/mcp";
import { runTrigger } from "../triggers";
import { requestChatDataMain } from "./request";
import type {
  requestDataArgument,
  requestDataResponse,
} from "./requestContracts";
import type { ModelModeExtended } from "./shared";

export async function requestChatData(
  arg: requestDataArgument,
  model: ModelModeExtended,
  abortSignal: AbortSignal = null,
): Promise<requestDataResponse> {
  const db = getDatabase();
  const fallBackModels: string[] = safeStructuredClone(
    db?.fallbackModels?.[model] ?? [],
  );
  const tools = arg.tools ?? (await getTools());
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
      fallbackWhenBlankResponse: db.fallbackWhenBlankResponse,
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
          const currentChar = getCurrentCharacter();
          if (currentChar?.type !== "group") {
            const perf = performance.now();
            const triggerResult = await runTrigger(currentChar, "request", {
              chat: getCurrentChat(),
              displayMode: true,
              displayData: JSON.stringify(arg.formated),
            });

            const formated = JSON.parse(triggerResult.displayData);
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
            staticModel: fallbackModel,
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
