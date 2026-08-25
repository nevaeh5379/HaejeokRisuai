import { language } from "src/lang";
import {
  DEFAULT_MISTRAL_API_URL,
  decodeMistralResponse,
  formatMistralMessages,
} from "@risuai/chat-core/mistralProvider.cjs";
import {
  DEFAULT_OPENAI_CHAT_COMPLETIONS_URL,
  applyOpenAIPostParameterBodyPolicies,
  applyOpenAIPreParameterBodyPolicies,
  buildOpenAIRequestHeaders,
  normalizeOpenAIProviderMessages,
  resolveOpenAIRequestEndpoint,
  resolveOpenAIRequestModel,
} from "@risuai/chat-core/openAIProvider.cjs";
import { prepareOpenAILogitBias } from "./biasPreparation";
import { prepareOpenAIProviderMessages } from "./messagePreparation";
import { interpretOpenAINonStreamingResponse } from "./nonStreamingResponse";
import { getTranStream, wrapToolStream } from "./streamingResponse";
import { getDatabase } from "src/ts/storage/database.svelte";
import { LLMFlags, LLMFormat, LLMProvider } from "src/ts/model/modellist";
import { getFreeOpenRouterModels } from "src/ts/model/openrouter";
import {
  addFetchLog,
  fetchNative,
  globalFetch,
  textifyReadableStream,
} from "src/ts/globalApi.svelte";
import { isNodeServer, isTauri } from "src/ts/platform";
import { simplifySchema } from "src/ts/util";

import { getOpenAIJSONSchema } from "../../templates/jsonSchema";
import { applyChatTemplate } from "../../templates/chatTemplate";
import { supportsInlayImage } from "../../files/inlays";
import type {
  RequestDataArgumentExtended,
  requestDataResponse,
} from "../request";
import {
  tryExecuteNodeProvider,
  tryExecuteNodeProviderTransport,
} from "../nodeProviderExecutor";
import {
  applyAdditionalParameters,
  applyParameters,
  getAdditionalParameters,
} from "../shared";

import type { OpenAIChatExtra } from "./types";

import {
  getLocalNetworkRequestOptions,
  type LocalNetworkRequestOptions,
} from "./shared";
export { requestOpenAIResponseAPI, __testResponsesAPI } from "./responses";
function isOfficialOpenAIURL(url: string): boolean {
  try {
    return new URL(url).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

function shouldUseOpenAIFlexProcessing(
  aiModel: string,
  url: string,
  provider: LLMProvider,
): boolean {
  const isCustomEndpoint =
    aiModel === "reverse_proxy" || aiModel.startsWith("xcustom:::");
  return (
    provider === LLMProvider.OpenAI ||
    (isCustomEndpoint && isOfficialOpenAIURL(url))
  );
}

export async function requestOpenAI(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  const formated = arg.formated;
  const db = getDatabase();
  const aiModel = arg.aiModel;
  let formatedChat = await prepareOpenAIProviderMessages(
    formated as OpenAIChatExtra[],
    db.gptVisionQuality,
  );

  formatedChat = normalizeOpenAIProviderMessages(formatedChat, {
    newOAIHandle: db.newOAIHandle,
    deepSeekPrefix: arg.modelInfo.flags.includes(LLMFlags.deepSeekPrefix),
    deepSeekThinkingInput: arg.modelInfo.flags.includes(
      LLMFlags.deepSeekThinkingInput,
    ),
    reverseProxyOobaMode:
      aiModel === "reverse_proxy" && db.reverseProxyOobaMode,
    developerRole: arg.modelInfo.flags.includes(LLMFlags.DeveloperRole),
  });

  arg.bias = await prepareOpenAILogitBias(arg.biasString, arg.bias);

  let requestModel =
    aiModel === "reverse_proxy" || aiModel === "openrouter"
      ? db.proxyRequestModel
      : aiModel;
  let openrouterRequestModel = db.openrouterRequestModel;
  if (aiModel === "reverse_proxy") {
    requestModel = db.customProxyRequestModel;
  }
  if (aiModel === "nanogpt") {
    requestModel = db.nanogptRequestModel;
  }

  if (aiModel === "openrouter" && db.openrouterRequestModel === "risu/free") {
    openrouterRequestModel = await getFreeOpenRouterModels();
  }

  console.log(formatedChat);
  if (arg.modelInfo.format === LLMFormat.Mistral) {
    requestModel = aiModel;

    const reformatedChat = formatMistralMessages(formatedChat);

    const requestURL = arg.customURL ?? DEFAULT_MISTRAL_API_URL;
    const networkOptions = getLocalNetworkRequestOptions(requestURL, db, false);

    const targs = {
      body: applyParameters(
        {
          model: requestModel,
          messages: reformatedChat,
          safe_prompt: false,
          max_tokens: arg.maxTokens,
        },
        ["temperature", "presence_penalty", "frequency_penalty", "top_p"],
        {},
        arg.mode,
        {
          modelId: arg.modelInfo.id,
        },
      ),
      headers: {
        Authorization: "Bearer " + (arg.key ?? db.mistralKey),
      },
      abortSignal: arg.abortSignal,
      chatId: arg.chatId,
      interceptor: "mistral",
      networkRoute: networkOptions.networkRoute,
      requestTimeoutMs: networkOptions.requestTimeoutMs,
    } as const;

    if (arg.previewBody) {
      return {
        type: "success",
        result: JSON.stringify({
          url: requestURL,
          body: targs.body,
          headers: targs.headers,
        }),
      };
    }

    if (requestURL === DEFAULT_MISTRAL_API_URL) {
      const remote = await tryExecuteNodeProvider(
        LLMFormat.Mistral,
        {
          body: targs.body,
          apiKey: arg.key ?? db.mistralKey,
          httpErrorPrefix: language.errors.httpError,
        },
        arg.abortSignal,
      );
      if (remote) return remote;
    }

    const res = await globalFetch(requestURL, targs);
    return decodeMistralResponse(res.ok, res.data, language.errors.httpError);
  }

  db.cipherChat = false;
  let body: {
    [key: string]: any;
  } = {
    model: resolveOpenAIRequestModel({
      aiModel,
      requestModel,
      openRouterRequestModel: openrouterRequestModel,
      nanoGPTRequestModel: db.nanogptRequestModel,
      internalID: arg.modelInfo.internalID,
    }),
    messages: formatedChat,
    max_tokens: arg.maxTokens,
    logit_bias: arg.bias,
    stream: false,
  };

  body = applyOpenAIPreParameterBodyPolicies(body, {
    useCompletionTokens: arg.modelInfo.flags.includes(
      LLMFlags.OAICompletionTokens,
    ),
    generationSeed: db.generationSeed,
    responseJsonSchema:
      (db.jsonSchemaEnabled || arg.schema) &&
      !arg.modelInfo.flags.includes(LLMFlags.noStructuredOutput)
        ? getOpenAIJSONSchema(arg.schema)
        : undefined,
    prediction: db.OAIPrediction,
    aiModel,
    openRouterFallback: db.openrouterFallback,
    openRouterMiddleOut: db.openrouterMiddleOut,
    openRouterProvider: db.openrouterProvider,
    instructPrompt:
      aiModel === "openrouter" && db.useInstructPrompt
        ? applyChatTemplate(formated)
        : undefined,
  });

  body = applyParameters(body, arg.modelInfo.parameters, {}, arg.mode, {
    modelId: arg.modelInfo.id,
  });

  const hasTools = Boolean(arg.tools && arg.tools.length > 0);
  const postPolicies = applyOpenAIPostParameterBodyPolicies(body, {
    deepSeekThinkingToggle: arg.modelInfo.flags.includes(
      LLMFlags.deepSeekThinkingToggle,
    ),
    deepSeekThinkingType: db.deepseekThinkingType,
    deepSeekReasoningEffort: db.deepseekReasoningEffort,
    toolDefinitions: hasTools
      ? arg.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: simplifySchema(tool.inputSchema),
          },
        }))
      : undefined,
    reverseProxyOobaMode:
      aiModel === "reverse_proxy" && db.reverseProxyOobaMode,
    reverseProxyOobaArgs: db.reverseProxyOobaArgs,
    removeLogitBiasForInlay:
      supportsInlayImage() &&
      !(
        aiModel.startsWith("gpt") ||
        (aiModel === "reverse_proxy" &&
          (db.proxyRequestModel?.startsWith("gpt") ||
            (db.proxyRequestModel === "custom" &&
              db.customProxyRequestModel.startsWith("gpt"))))
      ),
    multiGen: arg.multiGen,
    hasTools,
    genTime: db.genTime,
  });
  body = postPolicies.body;
  if (postPolicies.error) {
    return { type: "fail", result: postPolicies.error };
  }

  const endpoint = resolveOpenAIRequestEndpoint({
    aiModel,
    customURL: arg.customURL,
    modelEndpoint: arg.modelInfo?.endpoint,
    nanoGPTUseSubscriptionEndpoint: db.nanogptUseSubscriptionEndpoint,
    autofillRequestUrl: db.autofillRequestUrl,
  });
  const replacerURL = endpoint.url;
  const risuIdentify = endpoint.risuIdentify;

  if (
    db.openAIFlexProcessing &&
    shouldUseOpenAIFlexProcessing(aiModel, replacerURL, arg.modelInfo.provider)
  ) {
    body.service_tier = "flex";
  }

  let headers = buildOpenAIRequestHeaders({
    aiModel,
    key: arg.key,
    openAIKey: db.openAIKey,
    nanoGPTKey: db.nanogptKey,
    proxyKey: db.proxyKey,
    openRouterKey: db.openrouterKey,
    keyIdentifier: arg.modelInfo?.keyIdentifier,
    keyByIdentifier: db.OaiCompAPIKeys,
    nanoGPTProvider: db.nanogptProvider,
    risuIdentify,
  });
  body = applyAdditionalParameters(
    body,
    headers,
    getAdditionalParameters(aiModel),
  );

  // Some aux flows are intentionally non-streaming (e.g. memory/translate).
  // If custom Additional Parameters contains stream=true, force non-stream mode back.
  if (!arg.useStreaming) {
    body.stream = false;
  }

  const localNetworkOptions = getLocalNetworkRequestOptions(
    replacerURL,
    db,
    false,
  );
  const streamingLocalNetworkOptions = getLocalNetworkRequestOptions(
    replacerURL,
    db,
    true,
  );

  if (arg.useStreaming) {
    body.stream = true;
    let urlHost = new URL(replacerURL).host;
    if (
      urlHost.includes("localhost") ||
      urlHost.includes("172.0.0.1") ||
      urlHost.includes("0.0.0.0")
    ) {
      if (!isTauri && !isNodeServer) {
        return {
          type: "fail",
          result:
            "You are trying local request on streaming. this is not allowed dude to browser/os security policy. turn off streaming.",
        };
      }
    }

    if (arg.previewBody) {
      return {
        type: "success",
        result: JSON.stringify({
          url: replacerURL,
          body: body,
          headers: headers,
        }),
      };
    }
    const da = await fetchNative(replacerURL, {
      body: JSON.stringify(body),
      method: "POST",
      headers: headers,
      signal: arg.abortSignal,
      chatId: arg.chatId,
      interceptor: "openai_streaming",
      networkRoute: streamingLocalNetworkOptions.networkRoute,
      requestTimeoutMs: streamingLocalNetworkOptions.requestTimeoutMs,
    });

    if (da.status !== 200) {
      return {
        type: "fail",
        result: await textifyReadableStream(da.body),
      };
    }

    if (!da.headers.get("Content-Type").includes("text/event-stream")) {
      return {
        type: "fail",
        result: await textifyReadableStream(da.body),
      };
    }

    addFetchLog({
      body: body,
      response: "Streaming",
      success: true,
      url: replacerURL,
      status: da.status,
    });

    const transtream = getTranStream(arg);

    da.body.pipeTo(transtream.writable);

    return {
      type: "streaming",
      result: wrapToolStream(
        transtream.readable,
        body,
        headers,
        replacerURL,
        arg,
        streamingLocalNetworkOptions,
      ),
    };
  }

  if (arg.previewBody) {
    return {
      type: "success",
      result: JSON.stringify({
        url: replacerURL,
        body: body,
        headers: headers,
      }),
    };
  }

  return requestHTTPOpenAI(
    replacerURL,
    body,
    headers,
    arg,
    localNetworkOptions,
  );
}

export async function requestHTTPOpenAI(
  replacerURL: string,
  body: any,
  headers: Record<string, string>,
  arg: RequestDataArgumentExtended,
  networkOptions: LocalNetworkRequestOptions = {},
): Promise<requestDataResponse> {
  const db = getDatabase();
  const remoteTransport =
    replacerURL === DEFAULT_OPENAI_CHAT_COMPLETIONS_URL &&
    arg.modelInfo.format === LLMFormat.OpenAICompatible
      ? await tryExecuteNodeProviderTransport(
          LLMFormat.OpenAICompatible,
          { body, headers },
          arg.abortSignal,
        )
      : null;
  const res =
    remoteTransport ??
    (await globalFetch(replacerURL, {
      body: body,
      headers: headers,
      abortSignal: arg.abortSignal,
      chatId: arg.chatId,
      interceptor: "openai_basic",
      networkRoute: networkOptions.networkRoute,
      requestTimeoutMs: networkOptions.requestTimeoutMs,
    }));

  return interpretOpenAINonStreamingResponse({
    ok: res.ok,
    data: res.data,
    body,
    arg,
    retry: () =>
      requestHTTPOpenAI(replacerURL, body, headers, arg, networkOptions),
  });
}

export async function requestOpenAILegacyInstruct(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  const formated = arg.formated;
  const db = getDatabase();
  const maxTokens = arg.maxTokens;
  const temperature = arg.temperature;
  const prompt =
    formated
      .filter((m) => m.content?.trim())
      .map((m) => {
        let author = "";

        if (m.role == "system") {
          m.content = m.content.trim();
        }

        console.log(m.role + ":" + m.content);
        switch (m.role) {
          case "user":
            author = "User";
            break;
          case "assistant":
            author = "Assistant";
            break;
          case "system":
            author = "Instruction";
            break;
          default:
            author = m.role;
            break;
        }

        return `\n## ${author}\n${m.content.trim()}`;
        //return `\n\n${author}: ${m.content.trim()}`;
      })
      .join("") + `\n## Response\n`;

  if (arg.previewBody) {
    return {
      type: "success",
      result: JSON.stringify({
        error: "This model is not supported in preview mode",
      }),
    };
  }

  let body: any = {
    model: "gpt-3.5-turbo-instruct",
    prompt: prompt,
    max_tokens: maxTokens,
    temperature: temperature,
    top_p: 1,
    stop: ["User:", " User:", "user:", " user:"],
    presence_penalty: arg.PresensePenalty || db.PresensePenalty / 100,
    frequency_penalty: arg.frequencyPenalty || db.frequencyPenalty / 100,
  };

  let headers: any = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + (arg.key ?? db.openAIKey),
  };

  body = applyAdditionalParameters(
    body,
    headers,
    getAdditionalParameters(arg.aiModel),
  );

  const response = await globalFetch(
    arg.customURL ?? "https://api.openai.com/v1/completions",
    {
      body: body,
      headers: headers,
      chatId: arg.chatId,
      abortSignal: arg.abortSignal,
    },
  );

  if (!response.ok) {
    return {
      type: "fail",
      result: language.errors.httpError + `${JSON.stringify(response.data)}`,
    };
  }
  const text: string = response.data.choices[0].text;
  return {
    type: "success",
    result: text.replace(/##\n/g, ""),
  };
}
