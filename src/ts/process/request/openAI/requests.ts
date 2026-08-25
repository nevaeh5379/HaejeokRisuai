import { language } from "src/lang";
import {
  DEFAULT_MISTRAL_API_URL,
  decodeMistralResponse,
  formatMistralMessages,
} from "@risuai/chat-core/mistralProvider.cjs";
import { DEFAULT_OPENAI_CHAT_COMPLETIONS_URL } from "@risuai/chat-core/openAIProvider.cjs";
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

  let oobaSystemPrompts: string[] = [];
  for (let i = 0; i < formatedChat.length; i++) {
    if (formatedChat[i].role !== "function") {
      if (!(
        formatedChat[i].name &&
        formatedChat[i].name.startsWith("example_") &&
        db.newOAIHandle
      )) {
        formatedChat[i].name = undefined;
      }
      if (
        db.newOAIHandle &&
        formatedChat[i].memo &&
        formatedChat[i].memo.startsWith("NewChat")
      ) {
        formatedChat[i].content = "";
      }
      if (
        arg.modelInfo.flags.includes(LLMFlags.deepSeekPrefix) &&
        i === formatedChat.length - 1 &&
        formatedChat[i].role === "assistant"
      ) {
        formatedChat[i].prefix = true;
      }
      if (
        arg.modelInfo.flags.includes(LLMFlags.deepSeekThinkingInput) &&
        i === formatedChat.length - 1 &&
        formatedChat[i].thoughts &&
        formatedChat[i].thoughts.length > 0 &&
        formatedChat[i].role === "assistant"
      ) {
        formatedChat[i].reasoning_content = formatedChat[i].thoughts.join("\n");
      }
      delete formatedChat[i].memo;
      delete formatedChat[i].removable;
      delete formatedChat[i].attr;
      delete formatedChat[i].multimodals;
      delete formatedChat[i].thoughts;
      delete formatedChat[i].cachePoint;
    }
    if (
      aiModel === "reverse_proxy" &&
      db.reverseProxyOobaMode &&
      formatedChat[i].role === "system"
    ) {
      const cont = formatedChat[i].content;
      if (typeof cont === "string") {
        oobaSystemPrompts.push(cont);
        formatedChat[i].content = "";
      }
    }
  }

  if (oobaSystemPrompts.length > 0) {
    formatedChat.push({
      role: "system",
      content: oobaSystemPrompts.join("\n"),
    });
  }

  if (db.newOAIHandle) {
    formatedChat = formatedChat.filter((m) => {
      return (
        m.content !== "" ||
        (m.multimodals && m.multimodals.length > 0) ||
        m.tool_calls ||
        m.role === "tool"
      );
    });
  }

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

  if (arg.modelInfo.flags.includes(LLMFlags.DeveloperRole)) {
    formatedChat = formatedChat.map((v) => {
      if (v.role === "system") {
        v.role = "developer";
      }
      return v;
    });
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
    model:
      aiModel === "nanogpt"
        ? db.nanogptRequestModel
        : aiModel === "openrouter"
          ? openrouterRequestModel
          : requestModel === "gpt35"
            ? "gpt-3.5-turbo"
            : requestModel === "gpt35_0613"
              ? "gpt-3.5-turbo-0613"
              : requestModel === "gpt35_16k"
                ? "gpt-3.5-turbo-16k"
                : requestModel === "gpt35_16k_0613"
                  ? "gpt-3.5-turbo-16k-0613"
                  : requestModel === "gpt4"
                    ? "gpt-4"
                    : requestModel === "gpt45"
                      ? "gpt-4.5-preview"
                      : requestModel === "gpt4_32k"
                        ? "gpt-4-32k"
                        : requestModel === "gpt4_0613"
                          ? "gpt-4-0613"
                          : requestModel === "gpt4_32k_0613"
                            ? "gpt-4-32k-0613"
                            : requestModel === "gpt4_1106"
                              ? "gpt-4-1106-preview"
                              : requestModel === "gpt4_0125"
                                ? "gpt-4-0125-preview"
                                : requestModel === "gptvi4_1106"
                                  ? "gpt-4-vision-preview"
                                  : requestModel === "gpt35_0125"
                                    ? "gpt-3.5-turbo-0125"
                                    : requestModel === "gpt35_1106"
                                      ? "gpt-3.5-turbo-1106"
                                      : requestModel === "gpt35_0301"
                                        ? "gpt-3.5-turbo-0301"
                                        : requestModel === "gpt4_0314"
                                          ? "gpt-4-0314"
                                          : requestModel ===
                                              "gpt4_turbo_20240409"
                                            ? "gpt-4-turbo-2024-04-09"
                                            : requestModel === "gpt4_turbo"
                                              ? "gpt-4-turbo"
                                              : requestModel === "gpt4o"
                                                ? "gpt-4o"
                                                : requestModel ===
                                                    "gpt4o-2024-05-13"
                                                  ? "gpt-4o-2024-05-13"
                                                  : requestModel === "gpt4om"
                                                    ? "gpt-4o-mini"
                                                    : requestModel ===
                                                        "gpt4om-2024-07-18"
                                                      ? "gpt-4o-mini-2024-07-18"
                                                      : requestModel ===
                                                          "gpt4o-2024-08-06"
                                                        ? "gpt-4o-2024-08-06"
                                                        : requestModel ===
                                                            "gpt4o-2024-11-20"
                                                          ? "gpt-4o-2024-11-20"
                                                          : requestModel ===
                                                              "gpt4o-chatgpt"
                                                            ? "chatgpt-4o-latest"
                                                            : requestModel ===
                                                                "gpt4o1-preview"
                                                              ? "o1-preview"
                                                              : requestModel ===
                                                                  "gpt4o1-mini"
                                                                ? "o1-mini"
                                                                : arg.modelInfo
                                                                      .internalID
                                                                  ? arg
                                                                      .modelInfo
                                                                      .internalID
                                                                  : !requestModel
                                                                    ? "gpt-3.5-turbo"
                                                                    : requestModel,
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

  let replacerURL =
    aiModel === "nanogpt"
      ? db.nanogptUseSubscriptionEndpoint
        ? "https://nano-gpt.com/api/subscription/v1/chat/completions"
        : "https://nano-gpt.com/api/v1/chat/completions"
      : aiModel === "openrouter"
        ? "https://openrouter.ai/api/v1/chat/completions"
        : (arg.customURL ?? DEFAULT_OPENAI_CHAT_COMPLETIONS_URL);

  if (arg.modelInfo?.endpoint) {
    replacerURL = arg.modelInfo.endpoint;
  }

  let risuIdentify = false;
  if (replacerURL.startsWith("risu::")) {
    risuIdentify = true;
    replacerURL = replacerURL.replace("risu::", "");
  }

  if (aiModel === "reverse_proxy" && db.autofillRequestUrl) {
    if (replacerURL.endsWith("v1")) {
      replacerURL += "/chat/completions";
    } else if (replacerURL.endsWith("v1/")) {
      replacerURL += "chat/completions";
    } else if (!(
      replacerURL.endsWith("completions") ||
      replacerURL.endsWith("completions/")
    )) {
      if (replacerURL.endsWith("/")) {
        replacerURL += "v1/chat/completions";
      } else {
        replacerURL += "/v1/chat/completions";
      }
    }
  }

  if (
    db.openAIFlexProcessing &&
    shouldUseOpenAIFlexProcessing(aiModel, replacerURL, arg.modelInfo.provider)
  ) {
    body.service_tier = "flex";
  }

  let headers = {
    Authorization:
      "Bearer " +
      (arg.key ??
        (aiModel === "nanogpt"
          ? db.nanogptKey
          : aiModel === "reverse_proxy"
            ? db.proxyKey
            : aiModel === "openrouter"
              ? db.openrouterKey
              : db.openAIKey)),
    "Content-Type": "application/json",
  };

  if (arg.modelInfo?.keyIdentifier) {
    headers["Authorization"] =
      "Bearer " + db.OaiCompAPIKeys[arg.modelInfo.keyIdentifier];
  }
  if (aiModel === "openrouter") {
    headers["X-Title"] = "RisuAI";
    headers["HTTP-Referer"] = "https://risuai.xyz";
  }
  if (aiModel === "nanogpt" && db.nanogptProvider) {
    headers["X-Provider"] = db.nanogptProvider;
  }
  if (risuIdentify) {
    headers["X-Proxy-Risu"] = "RisuAI";
  }
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
