import { language } from "src/lang";
import {
  DEFAULT_MISTRAL_API_URL,
  decodeMistralResponse,
  formatMistralMessages,
} from "@risuai/chat-core/mistralProvider.cjs";
import {
  DEFAULT_OPENAI_CHAT_COMPLETIONS_URL,
  buildOpenAIRequestHeaders,
  normalizeOpenAIProviderMessages,
  resolveOpenAIRequestEndpoint,
  resolveOpenAIRequestModel,
} from "@risuai/chat-core/openAIProvider.cjs";
import { interpretOpenAINonStreamingResponse } from "./nonStreamingResponse";
import { getTranStream, wrapToolStream } from "./streamingResponse";
import { getDatabase } from "src/ts/storage/database.svelte";
import { LLMFlags, LLMFormat, LLMProvider } from "src/ts/model/modellist";
import { strongBan, tokenizeNum } from "src/ts/tokenizer";
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
import { decodeToolCall } from "../../mcp/mcp";
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

import type { Contents, OpenAIChatExtra } from "./types";

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
  let formatedChat: OpenAIChatExtra[] = [];
  const formated = arg.formated;
  const db = getDatabase();
  const aiModel = arg.aiModel;

  const processToolCalls = async (text: string, originalMessage: any) => {
    // Split text by tool_call tags and process each segment
    const segments = text.split(/(<tool_call>.*?<\/tool_call>)/gms);
    const processedMessages = [];

    let currentContent = "";

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];

      if (segment.match(/<tool_call>(.*?)<\/tool_call>/gms)) {
        // This is a tool call segment
        const toolCallMatch = segment.match(/<tool_call>(.*?)<\/tool_call>/s);
        if (toolCallMatch) {
          const call = await decodeToolCall(toolCallMatch[1]);
          if (call) {
            // Create assistant message with accumulated content and this tool call
            processedMessages.push({
              ...originalMessage,
              role: "assistant",
              content: currentContent,
              tool_calls: [
                {
                  id: call.call.id,
                  type: "function",
                  function: {
                    name: call.call.name,
                    arguments: call.call.arg,
                  },
                },
              ],
            });

            // Add tool response
            const textContents: string[] = [];
            for (const m of call.response) {
              if (m.type === "text") {
                textContents.push(m.text);
              }
            }

            processedMessages.push({
              role: "tool",
              content: textContents.join("\n"),
              tool_call_id: call.call.id,
              cachePoint: true,
            });

            // Reset content for next segment
            currentContent = "";
          }
        }
      } else {
        // This is regular text content - accumulate it
        currentContent += segment;
      }
    }

    // If there's remaining content without tool calls, add it as a regular message
    if (currentContent.trim()) {
      processedMessages.push({
        ...originalMessage,
        role: "assistant",
        content: currentContent,
      });
    }

    return processedMessages;
  };
  for (let i = 0; i < formated.length; i++) {
    const m = formated[i];

    // Check if message contains tool calls
    if (m.content && m.content.includes("<tool_call>")) {
      const processedMessages = await processToolCalls(m.content, m);
      formatedChat.push(...processedMessages);
    } else if (m.multimodals && m.multimodals.length > 0 && m.role === "user") {
      let v: OpenAIChatExtra = safeStructuredClone(m);
      let contents: Contents[] = [];
      for (let j = 0; j < m.multimodals.length; j++) {
        contents.push({
          type: "image_url",
          image_url: {
            url: m.multimodals[j].base64,
            detail: db.gptVisionQuality,
          },
        });
      }
      contents.push({
        type: "text",
        text: m.content,
      });
      v.content = contents;
      formatedChat.push(v);
    } else {
      formatedChat.push(m);
    }
  }

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

  for (let i = 0; i < arg.biasString.length; i++) {
    const bia = arg.biasString[i];
    if (bia[0].startsWith("[[") && bia[0].endsWith("]]")) {
      const num = parseInt(bia[0].replace("[[", "").replace("]]", ""));
      arg.bias[num] = bia[1];
      continue;
    }

    if (bia[1] === -101) {
      arg.bias = await strongBan(bia[0], arg.bias);
      continue;
    }
    const tokens = await tokenizeNum(bia[0]);

    for (const token of tokens) {
      arg.bias[token] = bia[1];
    }
  }

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

  if (Object.keys(body.logit_bias).length === 0) {
    delete body.logit_bias;
  }

  if (arg.modelInfo.flags.includes(LLMFlags.OAICompletionTokens)) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  }

  if (db.generationSeed > 0) {
    body.seed = db.generationSeed;
  }

  if (
    (db.jsonSchemaEnabled || arg.schema) &&
    !arg.modelInfo.flags.includes(LLMFlags.noStructuredOutput)
  ) {
    body.response_format = {
      type: "json_schema",
      json_schema: getOpenAIJSONSchema(arg.schema),
    };
  }

  if (db.OAIPrediction) {
    body.prediction = {
      type: "content",
      content: db.OAIPrediction,
    };
  }

  if (aiModel === "openrouter") {
    if (db.openrouterFallback) {
      body.route = "fallback";
    }
    body.transforms = db.openrouterMiddleOut ? ["middle-out"] : [];

    if (db.openrouterProvider) {
      const provider: typeof db.openrouterProvider =
        {} as typeof db.openrouterProvider;
      if (db.openrouterProvider.order?.length) {
        provider.order = db.openrouterProvider.order;
      }
      if (db.openrouterProvider.only?.length) {
        provider.only = db.openrouterProvider.only;
      }
      if (db.openrouterProvider.ignore?.length) {
        provider.ignore = db.openrouterProvider.ignore;
      }
      if (Object.keys(provider).length) {
        body.provider = provider;
      }
    }

    if (db.useInstructPrompt) {
      delete body.messages;
      const prompt = applyChatTemplate(formated);
      body.prompt = prompt;
    }
  }

  body = applyParameters(body, arg.modelInfo.parameters, {}, arg.mode, {
    modelId: arg.modelInfo.id,
  });

  if (arg.modelInfo.flags.includes(LLMFlags.deepSeekThinkingToggle)) {
    if (db.deepseekThinkingType === "enabled") {
      body.thinking = {
        type: "enabled",
        reasoning_effort: db.deepseekReasoningEffort ?? "high",
      };
      delete body.temperature;
      delete body.top_p;
      delete body.frequency_penalty;
      delete body.presence_penalty;
    } else {
      body.thinking = { type: "disabled" };
    }
  }

  if (arg.tools && arg.tools.length > 0) {
    body.tools = arg.tools.map((tool) => {
      return {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: simplifySchema(tool.inputSchema),
        },
      };
    });
  }

  if (aiModel === "reverse_proxy" && db.reverseProxyOobaMode) {
    const OobaBodyTemplate = db.reverseProxyOobaArgs;

    const keys = Object.keys(OobaBodyTemplate);
    for (const key of keys) {
      if (
        OobaBodyTemplate[key] !== undefined &&
        OobaBodyTemplate[key] !== null
      ) {
        body[key] = OobaBodyTemplate[key];
      }
    }
  }

  if (supportsInlayImage()) {
    // inlay models doesn't support logit_bias
    // OpenAI's gpt based llm model supports both logit_bias and inlay image
    if (!(
      aiModel.startsWith("gpt") ||
      (aiModel == "reverse_proxy" &&
        (db.proxyRequestModel?.startsWith("gpt") ||
          (db.proxyRequestModel === "custom" &&
            db.customProxyRequestModel.startsWith("gpt"))))
    )) {
      delete body.logit_bias;
    }
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
  if (arg.multiGen) {
    // Check if tools are enabled - multiGen with tools is not supported
    if (arg.tools && arg.tools.length > 0) {
      return {
        type: "fail",
        result:
          "MultiGen mode cannot be used with tool calls. Please disable one of them.",
      };
    }
    body.n = db.genTime;
  }

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
