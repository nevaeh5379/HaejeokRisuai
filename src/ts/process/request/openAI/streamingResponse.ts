import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import {
  appendOpenAIStreamingFragment,
  mergeOpenAIStreamingToolCallDeltas,
} from "@risuai/chat-core/openAIProvider.ts";
import { alertError } from "src/ts/alert";
import { addFetchLog, fetchNative } from "src/ts/globalApi.svelte";
import { LLMFlags } from "src/ts/model/modellist";

import { callTool, encodeToolCall } from "../../mcp/mcp";
import { extractJSON } from "../../templates/jsonSchema";
import type {
  RequestDataArgumentExtended,
  StreamResponseChunk,
} from "../requestContracts";
import {
  resolveRequestParserContext,
  resolveRequestToolContext,
} from "../requestContext";
import type { OpenAIChatExtra, ToolCall } from "./types";
import type { LocalNetworkRequestOptions } from "./shared";

export function getTranStream(
  arg: RequestDataArgumentExtended,
): TransformStream<Uint8Array, StreamResponseChunk> {
  const decoder = new TextDecoder("utf-8");
  let lineBuffer = "";
  const rawContent: Record<string, string> = {};
  let structuredReasoning = "";
  let reasoningFromStructured = false;
  let toolCallsMap: Record<string, any> = {};
  let hasToolCalls = false;
  let done = false;

  function processBufferedLines(
    control: TransformStreamDefaultController<StreamResponseChunk>,
  ) {
    if (done) return;
    let newlineIndex: number;
    let hasNewData = false;

    while ((newlineIndex = lineBuffer.indexOf("\n")) !== -1) {
      const line = lineBuffer.slice(0, newlineIndex).trimEnd();
      lineBuffer = lineBuffer.slice(newlineIndex + 1);

      if (!line.startsWith("data: ")) continue;
      const rawChunk = line.slice(6).trim();
      if (!rawChunk) continue;

      hasNewData = true;
      if (rawChunk === "[DONE]") {
        done = true;
        break;
      }

      try {
        const parsed = JSON.parse(rawChunk);
        const choices = parsed.choices;
        if (Array.isArray(choices)) {
          for (let c = 0; c < choices.length; c++) {
            const choice = choices[c];
            const textFragment = choice.delta?.content ?? choice.text;
            if (textFragment) {
              const key = arg.multiGen ? String(choice.index ?? 0) : "0";
              rawContent[key] = appendOpenAIStreamingFragment(
                rawContent[key] ?? "",
                textFragment,
              );
            }

            if (choice?.delta?.tool_calls) {
              hasToolCalls = true;
              toolCallsMap = mergeOpenAIStreamingToolCallDeltas(
                toolCallsMap,
                choice.delta.tool_calls,
              );
            }

            const reasoningChunk =
              choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
            if (reasoningChunk) {
              reasoningFromStructured = true;
              structuredReasoning = appendOpenAIStreamingFragment(
                structuredReasoning,
                reasoningChunk,
              );
            }
          }
        }
      } catch {}
    }

    if (!hasNewData) return;

    let currentReasoning = structuredReasoning;
    const readed: Record<string, string> = { ...rawContent };
    if (!readed["0"]) readed["0"] = "";

    if (
      arg.modelInfo.flags.includes(LLMFlags.deepSeekThinkingOutput) &&
      !reasoningFromStructured
    ) {
      readed["0"] = readed["0"].replace(/(.*)\<\/think\>/gms, (m, p1) => {
        currentReasoning = p1;
        return "";
      });

      if (currentReasoning) {
        currentReasoning = currentReasoning.replace(/\<think\>/gm, "");
      }
    }

    if (hasToolCalls) {
      readed["__tool_calls"] = JSON.stringify(toolCallsMap);
    }

    if (
      arg.extractJson &&
      (presetStore.state.jsonSchemaEnabled || arg.schema)
    ) {
      const JSONreaded: Record<string, string> = {};
      for (const key in readed) {
        if (key === "__tool_calls") continue;
        JSONreaded[key] = extractJSON(
          readed[key],
          arg.extractJson,
          resolveRequestParserContext(arg),
        );
      }
      if (hasToolCalls) {
        JSONreaded["__tool_calls"] = readed["__tool_calls"];
      }
      control.enqueue(JSONreaded);
    } else if (currentReasoning) {
      const chunkObj: Record<string, string> = {
        "0": `<Thoughts>\n${currentReasoning}\n</Thoughts>\n${readed["0"] ?? ""}`,
      };
      if (hasToolCalls) {
        chunkObj["__tool_calls"] = readed["__tool_calls"];
      }
      control.enqueue(chunkObj);
    } else {
      control.enqueue(readed);
    }
  }

  return new TransformStream<Uint8Array, StreamResponseChunk>({
    transform(chunk, control) {
      if (done) return;
      lineBuffer += decoder.decode(chunk, { stream: true });
      processBufferedLines(control);
    },
    flush(control) {
      if (done) return;
      lineBuffer += decoder.decode();
      if (!lineBuffer) return;
      lineBuffer += "\n";
      processBufferedLines(control);
    },
  });
}

export function wrapToolStream(
  stream: ReadableStream<StreamResponseChunk>,
  body: any,
  headers: Record<string, string>,
  replacerURL: string,
  arg: RequestDataArgumentExtended,
  networkOptions: LocalNetworkRequestOptions = {},
): ReadableStream<StreamResponseChunk> {
  return new ReadableStream<StreamResponseChunk>({
    async start(controller) {
      const db = settingsStore.state;
      let reader = stream.getReader();
      let prefix = "";
      let lastValue;

      const extractThoughts = (text: string) => {
        let reasoningContent = "";
        const content = text.replace(
          /<Thoughts>\n?([\s\S]*?)\n?<\/Thoughts>\n*/g,
          (_, p1: string) => {
            reasoningContent += (reasoningContent ? "\n" : "") + p1;
            return "";
          },
        );
        return {
          content,
          reasoningContent,
        };
      };

      while (true) {
        let { done, value } = await reader.read();

        let content = value?.["0"] || "";
        if (done) {
          value = lastValue ?? { "0": "" };
          content = value?.["0"] || "";

          const rawToolCalls =
            JSON.parse(value?.["__tool_calls"] || "{}") || {};
          const toolCalls: ToolCall[] = [];
          if (Array.isArray(rawToolCalls)) {
            for (let i = 0; i < rawToolCalls.length; i++) {
              if (rawToolCalls[i]) toolCalls.push(rawToolCalls[i]);
            }
          } else if (
            typeof rawToolCalls === "object" &&
            rawToolCalls !== null
          ) {
            for (const key of Object.keys(rawToolCalls)) {
              const item = rawToolCalls[key];
              if (item) toolCalls.push(item);
            }
          }
          if (toolCalls && toolCalls.length > 0) {
            const messages = body.messages as OpenAIChatExtra[];
            let assistantContent = content;
            let assistantReasoningContent = "";
            const shouldPassDeepSeekReasoning =
              arg.modelInfo.flags.includes(LLMFlags.deepSeekThinkingInput) ||
              (arg.modelInfo.flags.includes(LLMFlags.deepSeekThinkingToggle) &&
                presetStore.state.deepseekThinkingType === "enabled");

            if (shouldPassDeepSeekReasoning) {
              const extracted = extractThoughts(content);
              assistantContent = extracted.content;
              assistantReasoningContent = extracted.reasoningContent;
            }

            const assistantMessage: OpenAIChatExtra = {
              role: "assistant",
              content: db.simplifiedToolUse ? "" : assistantContent,
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: {
                  name: call.function.name,
                  arguments: call.function.arguments,
                },
              })),
            };
            if (assistantReasoningContent) {
              assistantMessage.reasoning_content = assistantReasoningContent;
            }

            messages.push(assistantMessage);

            const callCodes: string[] = [];

            for (const toolCall of toolCalls) {
              if (
                !toolCall.function ||
                !toolCall.function.name ||
                !toolCall.function.arguments
              ) {
                continue;
              }
              try {
                const functionArgs = JSON.parse(toolCall.function.arguments);
                if (arg.tools && arg.tools.length > 0) {
                  const tool = arg.tools.find(
                    (t) => t.name === toolCall.function.name,
                  );
                  if (!tool) {
                    messages.push({
                      role: "tool",
                      content:
                        "No tool found with name: " + toolCall.function.name,
                      tool_call_id: toolCall.id,
                    });
                  } else {
                    const parsed = functionArgs;
                    const x = (
                      await callTool(
                        tool.name,
                        parsed,
                        tool.mcpURL,
                        resolveRequestToolContext(arg),
                      )
                    ).filter((m) => m.type === "text");
                    if (x.length > 0) {
                      messages.push({
                        role: "tool",
                        content: x[0].text,
                        tool_call_id: toolCall.id,
                      });
                      if (arg.rememberToolUsage) {
                        callCodes.push(
                          await encodeToolCall({
                            call: {
                              id: toolCall.id,
                              name: toolCall.function.name,
                              arg: toolCall.function.arguments,
                            },
                            response: x,
                          }),
                        );
                      }
                    } else {
                      messages.push({
                        role: "tool",
                        content: "Tool call failed with no text response",
                        tool_call_id: toolCall.id,
                      });
                    }
                  }
                }
              } catch (error) {
                messages.push({
                  role: "tool",
                  content: "Tool call failed with error: " + error,
                  tool_call_id: toolCall.id,
                });
              }
            }

            body.messages = messages;

            let resRec;
            let attempt = 0;
            let errorFlag = true;

            do {
              attempt++;
              resRec = await fetchNative(replacerURL, {
                body: JSON.stringify(body),
                method: "POST",
                headers: headers,
                signal: arg.abortSignal,
                chatId: arg.chatId,
                interceptor: "openai_tool",
                networkRoute: networkOptions.networkRoute,
                requestTimeoutMs: networkOptions.requestTimeoutMs,
              });

              if (
                resRec.status == 200 &&
                resRec.headers.get("Content-Type").includes("text/event-stream")
              ) {
                addFetchLog({
                  body: body,
                  response: "Streaming",
                  success: true,
                  url: replacerURL,
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

            const transtream = getTranStream(arg);
            resRec.body.pipeTo(transtream.writable);

            reader = transtream.readable.getReader();

            prefix +=
              (content && !db.simplifiedToolUse ? content + "\n\n" : "") +
              callCodes.join("\n\n");
            controller.enqueue({ "0": prefix });

            continue;
          }
          return controller.close();
        }

        lastValue = value;

        controller.enqueue({ "0": (prefix ? prefix + "\n\n" : "") + content });
      }
    },
  });
}
