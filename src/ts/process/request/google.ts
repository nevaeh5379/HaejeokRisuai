import {
  GOOGLE_GENERATION_PARAMETER_RENAMES,
  buildGoogleGenerateContentUrl,
  buildGoogleSafetySettings,
  finalizeGoogleGenerationConfig,
  mergeGoogleConsecutiveChats,
  prepareGoogleConversation,
  selectGoogleGenerationParameters,
} from "@risuai/chat-core/googleProvider.cjs";
import type {
  GeminiChat,
  GeminiFunctionCall,
  GeminiPart,
} from "@risuai/chat-core/googleProvider.cjs";
import { fetchNative, textifyReadableStream } from "src/ts/globalApi.svelte";
import { LLMFlags, LLMFormat, type LLMModel } from "src/ts/model/modellist";
import { getDatabase, setDatabase } from "src/ts/storage/database.svelte";
import { base64url, simplifySchema } from "src/ts/util";
import { v4 } from "uuid";
import {
  saveInlayedSignature,
  setInlayAsset,
  writeInlayImage,
  type InlaySignature,
} from "../files/inlays";
import { extractJSON, getGeneralJSONSchema } from "../templates/jsonSchema";
import { callTool, decodeToolCall, encodeToolCall } from "../mcp/mcp";
import { alertError } from "src/ts/alert";
import { addFetchLog } from "src/ts/globalApi.svelte";
import type {
  RequestDataArgumentExtended,
  requestDataResponse,
  StreamResponseChunk,
} from "./requestContracts";
import { tryExecuteNodeProviderTransport } from "./nodeProviderExecutor";
import {
  applyAdditionalParameters,
  applyParameters,
  getAdditionalParameters,
} from "./shared";
import { bodyIntercepterStore } from "src/ts/stores.svelte";

export async function requestGoogleCloudVertex(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  const formated = arg.formated;
  const db = getDatabase();
  const maxTokens = arg.maxTokens;

  const preparedConversation = prepareGoogleConversation(formated, {
    hasImageInput: arg.modelInfo.flags.includes(LLMFlags.hasImageInput),
    hasAudioInput: arg.modelInfo.flags.includes(LLMFlags.hasAudioInput),
    hasVideoInput: arg.modelInfo.flags.includes(LLMFlags.hasVideoInput),
    resolveSignature: (modal) => {
      if (modal.type !== "signature" || !db.saveSignatures) return null;
      const sig: InlaySignature = JSON.parse(
        Buffer.from(modal.base64, "base64").toString("utf-8"),
      );
      if (
        sig.source !== arg.modelInfo.internalID &&
        sig.source !== arg.modelInfo.id
      ) {
        return null;
      }
      return {
        thought: true,
        thoughtSignature: sig.signatures[0].content,
      };
    },
  });
  if (preparedConversation.consumedLeadingSystem) {
    formated.shift();
  }
  let reformatedChat: GeminiChat[] = preparedConversation.chats;
  let systemPrompt = preparedConversation.systemPrompt;

  for (let i = 0; i < reformatedChat.length; i++) {
    let chat = reformatedChat[i];
    for (let j = 0; j < chat.parts.length; j++) {
      const part = chat.parts[j];
      if (part.text && part.text.includes("<tool_call>")) {
        // Analyze the entire text to sequentially process multiple tool_calls
        const toolCallMatches = [
          ...part.text.matchAll(/<tool_call>(.*?)<\/tool_call>/g),
        ];
        if (toolCallMatches.length > 0) {
          // Split the text by tool_call and reconstruct in order
          const segments = [];
          let lastIndex = 0;

          for (let k = 0; k < toolCallMatches.length; k++) {
            const match = toolCallMatches[k];
            // Text before tool_call
            if (match.index! > lastIndex) {
              segments.push({
                type: "text",
                content: part.text.substring(lastIndex, match.index).trim(),
                role: chat.role,
              });
            }

            // Handle tool_call
            const call = await decodeToolCall(match[1]);
            if (call) {
              const tool = arg?.tools?.find((t) => t.name === call.call.name);
              if (tool) {
                segments.push({
                  type: "functionCall",
                  call: call,
                  tool: tool,
                });
              }
            }

            lastIndex = match.index! + match[0].length;
          }
          // Last text after the last tool_call
          if (lastIndex < part.text.length) {
            segments.push({
              type: "text",
              content: part.text.substring(lastIndex).trim(),
              role: chat.role,
            });
          }
          // Keep the first text in the current part
          if (segments.length > 0 && segments[0].type === "text") {
            part.text = segments[0].content.trim() ? segments[0].content : "";
            segments.shift();
          } else {
            part.text = "";
          }

          // Mark the current part for removal if its text is empty
          const shouldRemoveCurrentPart = !part.text.trim();

          // Insert the remaining segments in order
          let insertIndex = i + 1;
          for (const segment of segments) {
            if (segment.type === "text") {
              // Insert only non-empty text
              if (segment.content.trim()) {
                reformatedChat.splice(insertIndex, 0, {
                  role: segment.role,
                  parts: [
                    {
                      text: segment.content,
                    },
                  ],
                });
                insertIndex++;
              }
            } else if (segment.type === "functionCall") {
              // Insert functionCall
              reformatedChat.splice(insertIndex, 0, {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      name: segment.call.call.name,
                      args: segment.call.call.arg,
                    },
                  },
                ],
              });
              insertIndex++;

              // Insert functionResponse
              reformatedChat.splice(insertIndex, 0, {
                role: "function",
                parts: [
                  {
                    functionResponse: {
                      name: segment.call.call.name,
                      response: {
                        data: (() => {
                          const res: string[] = [];
                          for (const r of segment.call.response) {
                            if (r.type === "text") {
                              res.push(r.text);
                            }
                          }
                          return res;
                        })(),
                      },
                    },
                  },
                ],
              });
              insertIndex++;
            }
          }
          // Remove the current part if its text is empty
          if (shouldRemoveCurrentPart) {
            reformatedChat.splice(i, 1);
            i = insertIndex - 2; // Adjust index after removal
          } else {
            i = insertIndex - 1; // Start from the correct position in the next loop
          }
        }
      }
    }
  }

  mergeGoogleConsecutiveChats(reformatedChat);

  const uncensoredCatagory = buildGoogleSafetySettings({
    includeCivicIntegrity: !arg.modelInfo.flags.includes(LLMFlags.noCivilIntegrity),
    blockOff: arg.modelInfo.flags.includes(LLMFlags.geminiBlockOff),
  });

  const para = selectGoogleGenerationParameters(arg.modelInfo.parameters, {
    thinking: arg.modelInfo.flags.includes(LLMFlags.geminiThinking),
  });

  let body: any = {
    contents: reformatedChat,
    generation_config: applyParameters(
      {
        maxOutputTokens: maxTokens,
      },
      para,
      GOOGLE_GENERATION_PARAMETER_RENAMES,
      arg.mode,
      {
        ignoreTopKIfZero: true,
        modelId: arg.modelInfo.id,
      },
    ),
    safetySettings: uncensoredCatagory,
    systemInstruction: {
      parts: [
        {
          text: systemPrompt,
        },
      ],
    },
    tools: {
      functionDeclarations:
        arg?.tools?.map((tool, i) => {
          console.log(tool.name, i);
          return {
            name: tool.name,
            description: tool.description,
            parameters: simplifySchema(tool.inputSchema),
          };
        }) ?? [],
    },
  };

  if (systemPrompt === "") {
    delete body.systemInstruction;
  }

  const finalizedGeneration = finalizeGoogleGenerationConfig(
    body.generation_config,
    {
      thinking: arg.modelInfo.flags.includes(LLMFlags.geminiThinking),
      thinkingNoMinimal: arg.modelInfo.flags.includes(
        LLMFlags.geminiThinkingNoMinimal,
      ),
      useStreaming: arg.useStreaming,
      hasAudioOutput: arg.modelInfo.flags.includes(LLMFlags.hasAudioOutput),
      hasImageOutput: arg.modelInfo.flags.includes(LLMFlags.hasImageOutput),
      imageResponse: arg.imageResponse,
      highMediaResolution: db.gptVisionQuality === "high",
    },
  );
  arg.useStreaming = finalizedGeneration.useStreaming;

  let headers: { [key: string]: string } = {
    "Content-Type": "application/json",
  };


  const PROJECT_ID = db.google.projectId;
  const REGION = db.vertexRegion;
  console.log(arg.modelInfo);

  const isVertexGlobalOnlyModel = (modelId: string) => {
    // Gemini 3 preview models and the 3.5/3.6/3.7 Flash family are not served from the regions
    // selectable in settings (us-central1, us-west1); route them through the global endpoint.
    return (
      /^gemini-3-.*-preview$/.test(modelId) ||
      /^gemini-3\.[567]-flash/.test(modelId)
    );
  };

  async function generateToken(email: string, key: string) {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error(
        "Web Crypto API is not available in this environment. Please ensure you are using HTTPS.",
      );
    }
    // Input validation
    if (!email.includes("gserviceaccount.com")) {
      throw new Error(
        "Invalid Vertex client email. Must include gserviceaccount.com",
      );
    }
    if (
      !key.includes("-----BEGIN PRIVATE KEY-----") ||
      !key.includes("-----END PRIVATE KEY-----")
    ) {
      throw new Error(
        "Invalid Vertex private key. Must include proper key markers.",
      );
    }

    function str2ab(privateKey: string): ArrayBuffer {
      const binaryString = atob(
        privateKey.replace(
          /-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\\n/g,
          "",
        ),
      );
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return bytes.buffer;
    }

    const time = Math.floor(Date.now() / 1000);

    const header = {
      alg: "RS256",
      typ: "JWT",
    };

    const claimSet = {
      iss: email,
      iat: time,
      exp: time + 3600,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
    };

    const encodedHeader = base64url(
      new TextEncoder().encode(JSON.stringify(header)),
    );
    const encodedClaimSet = base64url(
      new TextEncoder().encode(JSON.stringify(claimSet)),
    );

    const cryptokey = await crypto.subtle.importKey(
      "pkcs8",
      str2ab(key),
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: { name: "SHA-256" },
      },
      false,
      ["sign"],
    );

    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      cryptokey,
      new TextEncoder().encode(`${encodedHeader}.${encodedClaimSet}`),
    );

    const jwt = `${encodedHeader}.${encodedClaimSet}.${base64url(new Uint8Array(signature))}`;

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (!response.ok) {
      let errorText;
      try {
        errorText = JSON.stringify(await response.json());
      } catch {
        errorText = response.status.toString();
      }
      throw new Error(`Failed to refresh google access token: ${errorText}`);
    }

    const data = await response.json();
    const token = data.access_token;

    if (!token) {
      throw new Error("No google access token in the response");
    }

    const db2 = getDatabase();
    db2.vertexAccessToken = token;
    db2.vertexAccessTokenExpires = Date.now() + 3500 * 1000;
    setDatabase(db2);
    return token;
  }

  if (arg.modelInfo.format === LLMFormat.VertexAIGemini) {
    if (db.vertexAccessTokenExpires < Date.now()) {
      if (!db.vertexClientEmail || !db.vertexPrivateKey) {
        alertError(
          "Vertex AI authentication information is missing or incomplete. Please check your settings.",
        );
        return {
          type: "fail",
          result:
            "Vertex AI authentication information is missing or incomplete. Please check your settings.",
        };
      }
      headers["Authorization"] =
        "Bearer " +
        (await generateToken(db.vertexClientEmail, db.vertexPrivateKey));
    } else {
      headers["Authorization"] = "Bearer " + db.vertexAccessToken;
    }
  }

  if (db.jsonSchemaEnabled || arg.schema) {
    body.generation_config.response_mime_type = "application/json";
    body.generation_config.response_schema = getGeneralJSONSchema(arg.schema, [
      "$schema",
      "additionalProperties",
    ]);
    console.log(body.generation_config.response_schema);
  }

  let url = "";
  let apiKey = arg.key || db.google.accessToken;

  if (arg.customURL) {
    let baseURL = arg.customURL;
    if (!baseURL.endsWith("/")) {
      baseURL += "/";
    }
    const endpoint = arg.useStreaming
      ? "streamGenerateContent"
      : "generateContent";
    const u = new URL(
      `models/${arg.modelInfo.internalID}:${endpoint}`,
      baseURL,
    );
    u.searchParams.set("key", apiKey);
    if (arg.useStreaming) {
      u.searchParams.set("alt", "sse");
    }
    url = u.toString();
  } else if (arg.modelInfo.format === LLMFormat.VertexAIGemini) {
    const endpoint = arg.useStreaming
      ? "streamGenerateContent?alt=sse"
      : "generateContent";

    // Some models (e.g. Gemini 3 preview) are only available via the global endpoint.
    const effectiveRegion = isVertexGlobalOnlyModel(arg.modelInfo.internalID)
      ? "global"
      : REGION;

    url =
      effectiveRegion === "global"
        ? `https://aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${effectiveRegion}/publishers/google/models/${arg.modelInfo.internalID}:${endpoint}`
        : `https://${effectiveRegion}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${effectiveRegion}/publishers/google/models/${arg.modelInfo.internalID}:${endpoint}`;
  } else if (
    arg.modelInfo.format === LLMFormat.GoogleCloud &&
    arg.useStreaming
  ) {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${arg.modelInfo.internalID}:streamGenerateContent?key=${apiKey}&alt=sse`;
  } else {
    url = buildGoogleGenerateContentUrl(arg.modelInfo.internalID, apiKey);
  }
  // will return error if functionDeclarations is empty
  if (body.tools?.functionDeclarations?.length === 0) {
    body.tools = undefined;
  }

  body = applyAdditionalParameters(
    body,
    headers,
    getAdditionalParameters(arg.aiModel),
  );

  if (arg.previewBody) {
    return {
      type: "success",
      result: JSON.stringify({
        url: url,
        body: body,
        headers: headers,
      }),
    };
  }

  return requestGoogle(url, body, headers, arg);
}

async function requestGoogle(
  url: string,
  body: any,
  headers: { [key: string]: string },
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  const db = getDatabase();

  const fallBackGemini = async (
    originalError: string,
  ): Promise<requestDataResponse> => {
    if (!db.antiServerOverloads) {
      return {
        type: "fail",
        result: originalError,
        failByServerError: true,
      };
    }

    if (arg?.abortSignal?.aborted) {
      return {
        type: "fail",
        result: originalError,
        failByServerError: true,
      };
    }
    if (arg.modelInfo.format === LLMFormat.VertexAIGemini) {
      return {
        type: "fail",
        result: originalError,
        failByServerError: true,
      };
    }

    return requestGoogle(url, body, headers, arg);
  };

  // process the text parts into a single text response
  const processTextResponse = (
    rDatas: { text: string; thought?: boolean }[],
  ) => {
    if (arg.extractJson && (db.jsonSchemaEnabled || arg.schema)) {
      for (let i = 0; i < rDatas.length; i++) {
        const extracted = extractJSON(rDatas[i].text, arg.extractJson);
        rDatas[i].text = extracted;
      }
    }
    const thoughtsArr: string[] = [];
    const contentArr: string[] = [];
    for (const d of rDatas) {
      if (d.thought) {
        thoughtsArr.push(d.text);
      } else {
        contentArr.push(d.text);
      }
    }
    const thoughts = thoughtsArr.join("\n\n");
    const content = contentArr.join("\n\n");
    return (
      (thoughts ? `<Thoughts>\n\n${thoughts}\n\n</Thoughts>\n\n` : "") + content
    );
  };

  if (
    (arg.modelInfo.format === LLMFormat.GoogleCloud ||
      arg.modelInfo.format === LLMFormat.VertexAIGemini) &&
    arg.useStreaming
  ) {
    if (arg.previewBody) {
      return {
        type: "success",
        result: JSON.stringify({
          url: url,
          body: body,
          headers: headers,
        }),
      };
    }

    const f = await fetchNative(url, {
      headers: headers,
      body: JSON.stringify(body),
      method: "POST",
      chatId: arg.chatId,
      signal: arg.abortSignal,
      interceptor: "gemini_base_stream",
    });

    if (f.status !== 200) {
      const text = await textifyReadableStream(f.body);
      if (text.includes("RESOURCE_EXHAUSTED")) {
        return fallBackGemini(text);
      }
      return {
        type: "fail",
        result: text,
      };
    }

    const transtream = getTranStream({
      modelInfo: arg.modelInfo,
      saveSignature: arg.saveSignatures ?? false,
    });

    f.body.pipeTo(transtream.writable);

    return {
      type: "streaming",
      result: wrapToolStream(transtream.readable, body, headers, url, arg),
    };
  }

  const googleApiKey = arg.key || db.google.accessToken;
  const remoteTransport =
    arg.modelInfo.format === LLMFormat.GoogleCloud && !arg.customURL
      ? await tryExecuteNodeProviderTransport(
          LLMFormat.GoogleCloud,
          {
            body,
            headers,
            modelId: arg.modelInfo.internalID,
            apiKey: googleApiKey,
          },
          arg.abortSignal,
        )
      : null;

  let responseData: any;
  if (remoteTransport) {
    if (!remoteTransport.ok) {
      const data =
        typeof remoteTransport.data === "string"
          ? remoteTransport.data
          : JSON.stringify(remoteTransport.data);
      const text = JSON.stringify(data);
      if (text.includes("RESOURCE_EXHAUSTED")) {
        return fallBackGemini(text);
      }
      return {
        type: "fail",
        result: `${text} (status: ${remoteTransport.status})`,
      };
    }
    responseData = remoteTransport.data;
  } else {
    const res = await fetchNative(url, {
      headers: headers,
      body: JSON.stringify(body),
      method: "POST",
      chatId: arg.chatId,
      signal: arg.abortSignal,
      interceptor: "gemini_base",
    });

    if (!res.ok) {
      const data = await res.text();
      const text = JSON.stringify(data);
      if (text.includes("RESOURCE_EXHAUSTED")) {
        return fallBackGemini(text);
      }
      return {
        type: "fail",
        result: `${text} (status: ${res.status})`,
      };
    }
    responseData = await res.json();
  }

  let rDatas: { text: string; thought?: boolean }[] = [];
  const processDataItem = async (data: any): Promise<GeminiPart[]> => {
    const parts = data?.candidates?.[0]?.content?.parts as GeminiPart[];

    if (parts) {
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];

        if (part.text) {
          rDatas.push({
            text: part.text,
            thought: part.thought,
          });
        }

        if (part.thoughtSignature && arg.saveSignatures) {
          const sigId = v4();
          await saveInlayedSignature(sigId, {
            source: arg.modelInfo.internalID || arg.modelInfo.id,
            sourceFormat: arg.modelInfo.format,
            signatures: [
              {
                type: "text",
                content: part.text,
              },
            ],
          });
          rDatas[rDatas.length - 1].text =
            `{{inlayeddata::${sigId}}}\n\n` + rDatas[rDatas.length - 1].text;
        }

        if (part.inlineData) {
          const imgHTML = new Image();
          const id = crypto.randomUUID();

          if (part.inlineData.mimeType.startsWith("image/")) {
            imgHTML.src = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
            await writeInlayImage(imgHTML, {
              id: id,
            });
            rDatas.push({
              text: `{{inlayeddata::${id}}}`,
            });
          } else {
            const id = v4();
            await setInlayAsset(id, {
              name: "gemini-audio",
              type: "audio",
              data: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
              height: 0,
              width: 0,
              ext: part.inlineData.mimeType.split("/")[1],
            });
          }
        }
      }
    }

    if (data?.usageMetadata) {
      for (const interceptor of bodyIntercepterStore) {
        try {
          await interceptor.callback(
            {
              usageMetadata: data.usageMetadata,
              modelStatus: data.modelStatus,
              promptFeedback: data.promptFeedback,
            },
            "meta_gemini",
          );
        } catch (e) {
          console.error(e);
        }
      }
    }
    return parts;
  };

  // traverse responded data if it contains multipart contents
  let parts: GeminiPart[] = [];
  const resData = responseData;
  if (Array.isArray(resData)) {
    for (const data of resData) {
      const p = await processDataItem(data);
      parts = parts.concat(p);
    }
  } else {
    const p = await processDataItem(resData);
    parts = parts.concat(p);
  }
  parts = parts.filter((p) => p);

  const calls: GeminiFunctionCall[] = [];
  for (const p of parts) {
    if (p?.functionCall) {
      calls.push(p.functionCall as GeminiFunctionCall);
    }
  }

  // If there are function calls, handle calls and send next request
  if (calls.length > 0) {
    const chat = body.contents as GeminiChat[];

    // Add the model response part to the request content (only function calls if simplifiedToolUse is enabled)
    if (db.simplifiedToolUse) {
      chat.push({
        role: "model",
        parts: calls.map((call) => {
          return {
            functionCall: {
              name: call.name,
              args: call.args,
            },
          } as GeminiPart;
        }),
      });
    }
    // Add the model response part to the request content (text response and function calls)
    else {
      chat.push({
        role: "model",
        parts: parts.filter((p) => !p.thought),
      });
    }
    // If the last part is a model response, merge it with the previous model response
    if (chat[chat.length - 2]?.role === "model") {
      chat[chat.length - 2].parts = chat[chat.length - 2].parts.concat(
        chat[chat.length - 1].parts,
      );
      chat.pop();
    }

    const functionParts: GeminiPart[] = [];
    const callCodes: string[] = [];
    const tools = arg?.tools ?? [];

    // Handle tool calls
    for (const call of calls) {
      const functionName = call.name;
      const functionArgs = call.args;

      const tool = tools.find((t) => t.name === functionName);
      if (tool) {
        const result = (await callTool(tool.name, functionArgs)).filter((r) => {
          return r.type === "text";
        });
        if (result.length === 0) {
          functionParts.push({
            functionResponse: {
              name: call.name,
              response: "No response from tool.",
            },
          });
        }

        // Store the encoded tool call history for later use
        if (arg.rememberToolUsage) {
          callCodes.push(
            await encodeToolCall({
              call: {
                id: call.id,
                name: call.name,
                arg: call.args,
              },
              response: result,
            }),
          );
        }

        for (let i = 0; i < result.length; i++) {
          let response: any = result[i].text;
          try {
            //try json parse
            response = {
              data: JSON.parse(response),
            };
          } catch (error) {
            response = {
              data: response,
            };
          }
          functionParts.push({
            functionResponse: {
              name: call.name,
              response,
            },
          });
        }
      } else {
        functionParts.push({
          functionResponse: {
            name: call.name,
            response: `Tool ${call.name} not found.`,
          },
        });
      }
    }

    // Add the user response part to the request content (function responses)
    chat.push({
      role: "function",
      parts: functionParts,
    });

    body.contents = chat;

    // Send the next request recursively
    let resRec;
    let attempt = 0;
    do {
      attempt++;
      resRec = await requestGoogle(url, body, headers, arg);

      if (resRec.type != "fail") {
        break;
      }
    } while (attempt <= db.requestRetrys); // Retry up to db.requestRetrys times

    // Does not include the text response if simplifiedToolUse is enabled
    const result =
      (db.simplifiedToolUse ? "" : processTextResponse(rDatas) + "\n\n") +
      callCodes.join("\n\n");

    // If the next request fails, only the responses so far are returned
    if (resRec.type === "fail") {
      alertError(`Failed to fetch model response after tool execution`);
      return {
        type: "success",
        result: result,
      };
    } else if (resRec.type === "success") {
      return {
        type: "success",
        result: result + "\n\n" + resRec.result,
      };
    }

    return resRec;
  }

  const result = processTextResponse(rDatas);

  // fail if the result is empty
  if (!result) {
    return {
      type: "fail",
      result: `Got empty response: ${JSON.stringify(resData)}`,
    };
  }

  console.log(result);
  return {
    type: "success",
    result: result,
  };
}

function initStreamState(state?: { [key: string]: string }): {
  [key: string]: string;
} {
  if (!state) {
    return {
      __sign_text: "",
      __sign_function: "",
      __last_thought: "",
      __thoughts: "",
      __tool_calls: "[]",
      "0": "",
    };
  }
  state["__sign_text"] = state["__sign_text"] || "";
  state["__sign_function"] = state["__sign_function"] || "";
  state["__last_thought"] = state["__last_thought"] || "";
  state["__thoughts"] = state["__thoughts"] || "";
  state["__tool_calls"] = state["__tool_calls"] || "[]";
  state["0"] = state["0"] || "";
  return state;
}

function getTranStream(args: {
  modelInfo: LLMModel;
  saveSignature: boolean;
}): TransformStream<Uint8Array, StreamResponseChunk> {
  let buffer = "";
  const { modelInfo, saveSignature } = args;
  return new TransformStream<Uint8Array, StreamResponseChunk>({
    transform(chunk, control) {
      buffer += new TextDecoder().decode(chunk);
      const lines = buffer.split("\n");

      let readed = initStreamState();

      try {
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const dataStr = line.slice(6).trim();
            if (dataStr === "[DONE]") return;

            const jsonData = JSON.parse(dataStr);

            if (jsonData.candidates?.[0]?.content?.parts) {
              const parts = jsonData.candidates[0].content.parts;
              for (const part of parts) {
                if (part.text) {
                  readed["__thoughts"] += readed["__last_thought"];
                  readed["__last_thought"] = "";
                  if (part.thought) {
                    readed["__last_thought"] = part.text;
                  } else {
                    readed["0"] += part.text;
                  }
                  if (part.thoughtSignature) {
                    readed["__sign_text"] = part.thoughtSignature;
                    if (saveSignature) {
                      //Its a promise, but we don't need to await it here
                      const sigId = v4();
                      saveInlayedSignature(sigId, {
                        source: modelInfo.internalID || modelInfo.id,
                        sourceFormat: modelInfo.format,
                        signatures: [
                          {
                            type: "text",
                            content: part.text,
                          },
                        ],
                      });
                      readed["0"] += `{{inlayeddata::${sigId}}}`;
                    }
                  }
                }
                if (part.functionCall) {
                  const toolCallsData = JSON.parse(readed["__tool_calls"]);
                  toolCallsData.push(part.functionCall);
                  readed["__tool_calls"] = JSON.stringify(toolCallsData);
                  if (part.thoughtSignature) {
                    readed["__sign_function"] = part.thoughtSignature;
                    const sigId = v4();

                    if (saveSignature) {
                      //Its a promise, but we don't need to await it here
                      saveInlayedSignature(sigId, {
                        source: modelInfo.internalID || modelInfo.id,
                        sourceFormat: modelInfo.format,
                        signatures: [
                          {
                            type: "function",
                            content: `${part.functionCall.name}(${JSON.stringify(part.functionCall.args)})`,
                          },
                        ],
                      });
                      readed["0"] += `{{inlayeddata::${sigId}}}`;
                    }
                  }
                }
              }
            }

            if (jsonData.usageMetadata) {
              readed["__usageMetadata"] = JSON.stringify(
                jsonData.usageMetadata,
              );
            }
            if (jsonData.modelStatus) {
              readed["__modelStatus"] = JSON.stringify(jsonData.modelStatus);
            }
          }
        }
        control.enqueue(readed);
      } catch (error) {}
    },
  });
}

function wrapToolStream(
  stream: ReadableStream<StreamResponseChunk>,
  body: any,
  headers: Record<string, string>,
  url: string,
  arg: RequestDataArgumentExtended,
): ReadableStream<StreamResponseChunk> {
  return new ReadableStream<StreamResponseChunk>({
    async start(controller) {
      const db = getDatabase();
      let reader = stream.getReader();
      let prefix = "";
      let lastValue = initStreamState();

      while (true) {
        let { done, value } = await reader.read();

        value = initStreamState(value);

        if (arg.extractJson && (db.jsonSchemaEnabled || arg.schema)) {
          value["0"] = extractJSON(value["0"], arg.extractJson);
        }

        let content = value["0"];
        let thoughts = value["__thoughts"];
        let lastThought = value["__last_thought"];
        let signText = value["__sign_text"];
        let signFunction = value["__sign_function"];

        if (done) {
          value = initStreamState(lastValue);

          content = value["0"];
          thoughts = value["__thoughts"];
          lastThought = value["__last_thought"];

          // thoughtSignatures
          signText = value["__sign_text"];
          signFunction = value["__sign_function"];

          const calls = JSON.parse(
            value["__tool_calls"],
          ) as GeminiFunctionCall[];
          if (calls && calls.length > 0) {
            const chat = body.contents as GeminiChat[];

            // Add the model response part to the request content (only function calls if simplifiedToolUse is enabled)
            if (db.simplifiedToolUse) {
              chat.push({
                role: "model",
                parts: calls.map((call) => {
                  return {
                    functionCall: {
                      name: call.name,
                      args: call.args,
                    },
                  } as GeminiPart;
                }),
              });
            }
            // Add the model response part to the request content (text response and function calls)
            else {
              chat.push({
                role: "model",
                parts: [
                  {
                    text: content,
                    ...(signText ? { thoughtSignature: signText } : {}),
                  } as GeminiPart,
                ].concat(
                  calls.map(
                    (call, index) =>
                      ({
                        functionCall: {
                          name: call.name,
                          args: call.args,
                        },
                        ...(index === 0 && signFunction
                          ? { thoughtSignature: signFunction }
                          : {}),
                      }) as GeminiPart,
                  ),
                ),
              });
            }
            // If the last part is a model response, merge it with the previous model response
            if (chat[chat.length - 2]?.role === "model") {
              chat[chat.length - 2].parts = chat[chat.length - 2].parts.concat(
                chat[chat.length - 1].parts,
              );
              chat.pop();
            }
            const parts: GeminiPart[] = [];
            const callCodes: string[] = [];
            const tools = arg?.tools ?? [];
            // Handle tool calls
            for (const call of calls) {
              const functionName = call.name;
              const functionArgs = call.args;
              const tool = tools.find((t) => t.name === functionName);
              if (tool) {
                const result = (await callTool(tool.name, functionArgs)).filter(
                  (r) => {
                    return r.type === "text";
                  },
                );
                if (result.length === 0) {
                  parts.push({
                    functionResponse: {
                      name: call.name,
                      response: "No response from tool.",
                    },
                  });
                }
                // Store the encoded tool call history for later use
                if (arg.rememberToolUsage) {
                  callCodes.push(
                    await encodeToolCall({
                      call: {
                        id: call.id,
                        name: call.name,
                        arg: call.args,
                      },
                      response: result,
                    }),
                  );
                }
                for (let i = 0; i < result.length; i++) {
                  let response: any = result[i].text;
                  try {
                    //try json parse
                    response = {
                      data: JSON.parse(response),
                    };
                  } catch (error) {
                    response = {
                      data: response,
                    };
                  }
                  parts.push({
                    functionResponse: {
                      name: call.name,
                      response,
                    },
                  });
                }
              } else {
                parts.push({
                  functionResponse: {
                    name: call.name,
                    response: `Tool ${call.name} not found.`,
                  },
                });
              }
            }
            // Add the user response part to the request content (function responses)
            chat.push({
              role: "function",
              parts: parts,
            });

            body.contents = chat;

            headers["Content-Type"] = "application/json";

            let resRec;
            let attempt = 0;
            let errorFlag = true;

            do {
              attempt++;
              resRec = await fetchNative(url, {
                headers: headers,
                body: JSON.stringify(body),
                method: "POST",
                chatId: arg.chatId,
                signal: arg.abortSignal,
                interceptor: "gemini_tool",
              });

              if (resRec.status == 200) {
                addFetchLog({
                  body: body,
                  response: "Streaming",
                  success: true,
                  url: url,
                  status: resRec.status,
                });

                errorFlag = false;
                break;
              }
            } while (attempt <= db.requestRetrys); // Retry up to db.requestRetrys times

            if (errorFlag) {
              alertError(`Failed to fetch model response after tool execution`);
              return controller.close();
            }

            const transtream = getTranStream({
              modelInfo: arg.modelInfo,
              saveSignature: arg.saveSignatures ?? false,
            });
            resRec.body.pipeTo(transtream.writable);

            reader = transtream.readable.getReader();

            if (db.simplifiedToolUse) {
              prefix += callCodes.join("\n\n");
            } else {
              prefix +=
                (thoughts + lastThought
                  ? `<Thoughts>\n\n${thoughts + lastThought}\n\n</Thoughts>\n\n`
                  : "") +
                (content ? content + "\n\n" : "") +
                callCodes.join("\n\n");
            }

            controller.enqueue({ "0": prefix });

            continue;
          }

          for (const interceptor of bodyIntercepterStore) {
            try {
              await interceptor.callback(value, "meta_gemini_stream");
            } catch (e) {
              console.error(e);
            }
          }
          return controller.close();
        }

        lastValue = value;

        if (db.streamGeminiThoughts) {
          controller.enqueue({
            "0":
              (prefix ? prefix + "\n\n" : "") +
              (thoughts ? `<Thoughts>\n\n${thoughts}\n\n</Thoughts>\n\n` : "") +
              (lastThought ? lastThought + "\n\n" : "") +
              content,
          });
        } else {
          controller.enqueue({
            "0":
              (prefix ? prefix + "\n\n" : "") +
              (thoughts + lastThought
                ? `<Thoughts>\n\n${thoughts + lastThought}\n\n</Thoughts>\n\n`
                : "") +
              content,
          });
        }
      }
    },
  });
}
