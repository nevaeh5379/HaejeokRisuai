import {
  customProviderStore,
  pluginV2,
  type PluginV2ProviderArgument,
  type PluginV2ProviderOptions,
} from "../../plugins.svelte";
import {
  runWithPluginPermission,
  type PluginPermission,
} from "../pluginPermissionCache";
import { language } from "src/lang";
import { get } from "svelte/store";
import {
  LLMFlags,
  LLMFormat,
  LLMProvider,
  LLMTokenizer,
  type LLMModel,
} from "src/ts/model/types";
import { customV3ProviderMetaStore } from "../providerStore";

type PluginV3ProviderOptions = PluginV2ProviderOptions & { model?: LLMModel };
export function createProviderApi(
  getPermission: (
    permission: PluginPermission,
    reconfirm?: boolean | "periodically",
  ) => Promise<boolean>,
) {
  return {
    addProvider: (
      name: string,
      func: (
        arg: PluginV2ProviderArgument,
        abortSignal?: AbortSignal,
      ) => Promise<{
        success: boolean;
        content: string | ReadableStream<string>;
      }>,
      options?: PluginV3ProviderOptions,
    ) => {
      console.warn(
        `[WARN] addProvider is a powerful API that can potentially be unsafe if used incorrectly. addProvider's functionality might be limited or changed in future updates to ensure security. please use other APIs if possible.`,
      );
      const provs = get(customProviderStore);
      provs.push(name);
      pluginV2.providers.set(name, (arg, abortSignal) => {
        return runWithPluginPermission(
          () => getPermission("provider", "periodically"),
          async () => {
            //mode is overridden to v3, due to vulnerabilities using mode.
            //Alternative to mode will be added in future
            arg.mode = "v3";
            return func(arg, abortSignal);
          },
          {
            success: false,
            content: language.providerPermissionDenied,
          },
        );
      });
      pluginV2.providerOptions.set(name, options ?? {});
      customProviderStore.set(provs);

      const modelData: LLMModel = {
        id: `pluginmodel:::${name}`,
        name: options?.model?.name ?? name,
        shortName: options?.model?.shortName ?? name,
        fullName: options?.model?.fullName ?? name,
        internalID: options?.model?.internalID ?? `pluginmodel:::${name}`,
        provider: LLMProvider.AsIs,
        format: LLMFormat.Plugin,
        flags: options?.model?.flags ?? [LLMFlags.hasFullSystemPrompt],
        parameters: options?.model?.parameters ?? [
          "temperature",
          "top_p",
          "frequency_penalty",
          "presence_penalty",
          "repetition_penalty",
          "min_p",
          "top_a",
          "top_k",
          "thinking_tokens",
        ],
        tokenizer: options?.model?.tokenizer ?? LLMTokenizer.Unknown,
      };
      customV3ProviderMetaStore.push(modelData);
    },
  };
}
