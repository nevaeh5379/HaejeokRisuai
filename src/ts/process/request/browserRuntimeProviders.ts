import { language } from "../../../lang";
import { pluginProcess, pluginV2 } from "../../plugins/plugins.svelte";
import { getDatabase } from "../../storage/database.svelte";
import { unstringlizeChat } from "../stringlize";
import { applyChatTemplate } from "../templates/chatTemplate";
import { runTransformers } from "../transformers";
import { resolveRequestCharacter } from "./requestContext";
import type {
  RequestDataArgumentExtended,
  requestDataResponse,
  StreamResponseChunk,
} from "./requestContracts";
import {
  applyAdditionalParameters,
  applyParameters,
  getAdditionalParameters,
} from "./shared";

export async function requestPlugin(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  const db = getDatabase();
  const isV3Model = arg.aiModel.startsWith("pluginmodel:::");
  const responseModel = isV3Model ? arg.aiModel : "custom";
  try {
    const formated = arg.formated;
    const maxTokens = arg.maxTokens;
    const bias = arg.biasString;
    const model = isV3Model
      ? arg.aiModel.replace("pluginmodel:::", "")
      : db.currentPluginProvider;
    const v2Function = pluginV2.providers.get(model);

    if (arg.previewBody) {
      return {
        type: "success",
        result: JSON.stringify({
          error: "Plugin is not supported in preview mode",
        }),
      };
    }

    const d = v2Function
      ? await v2Function(
          applyParameters(
            {
              prompt_chat: formated,
              mode: arg.mode,
              bias: [],
              max_tokens: maxTokens,
            },
            [
              "frequency_penalty",
              "min_p",
              "presence_penalty",
              "repetition_penalty",
              "top_k",
              "top_p",
              "temperature",
            ],
            {},
            arg.mode,
            {
              modelId: arg.aiModel,
            },
          ) as any,
          arg.abortSignal,
        )
      : await pluginProcess({
          bias: bias,
          prompt_chat: formated,
          temperature: db.temperature / 100,
          max_tokens: maxTokens,
          presence_penalty: db.PresensePenalty / 100,
          frequency_penalty: db.frequencyPenalty / 100,
        });

    if (!d) {
      return {
        type: "fail",
        result: language.errors.unknownModel,
        model: responseModel,
      };
    } else if (!d.success) {
      return {
        type: "fail",
        result:
          d.content instanceof ReadableStream
            ? await new Response(d.content).text()
            : d.content,
        model: responseModel,
      };
    } else if (d.content instanceof ReadableStream) {
      let fullText = "";
      const piper = new TransformStream<string, StreamResponseChunk>({
        transform(chunk, control) {
          fullText += chunk;
          control.enqueue({
            "0": fullText,
          });
        },
      });

      return {
        type: "streaming",
        result: d.content.pipeThrough(piper),
        model: responseModel,
      };
    } else {
      return {
        type: "success",
        result: d.content ?? "",
        model: responseModel,
      };
    }
  } catch (error) {
    console.error(error);
    return {
      type: "fail",
      result:
        `Plugin Error from ${db.currentPluginProvider}: ` +
        JSON.stringify(error),
      model: responseModel,
    };
  }
}

export async function requestWebLLM(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  const formated = arg.formated;
  const db = getDatabase();
  const aiModel = arg.aiModel;
  const currentChar = resolveRequestCharacter(arg);
  const maxTokens = arg.maxTokens;
  const temperature = arg.temperature;
  const realModel = aiModel.split(":::")[1];
  const prompt = applyChatTemplate(formated, {
    currentChar,
    chatTarget: arg.triggerTarget,
  });

  if (arg.previewBody) {
    return {
      type: "success",
      result: JSON.stringify({
        error: "Preview body is not supported for WebLLM",
      }),
    };
  }
  const transformersParams = {
    temperature: temperature,
    max_new_tokens: maxTokens,
    top_k: db.ooba.top_k,
    top_p: db.ooba.top_p,
    repetition_penalty: db.ooba.repetition_penalty,
    typical_p: db.ooba.typical_p,
  } as any;

  const finalParams = applyAdditionalParameters(
    transformersParams,
    {},
    getAdditionalParameters(arg.aiModel),
  );

  const v = await runTransformers(prompt, realModel, finalParams);
  return {
    type: "success",
    result: unstringlizeChat(
      (v.generated_text as string) ?? "",
      formated,
      currentChar?.name ?? "",
      arg.triggerTarget,
    ),
  };
}
