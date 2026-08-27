import {
  appendOpenAIStreamingFragment,
  mergeOpenAIStreamingToolCallDeltas,
} from "@risuai/chat-core/openAIProvider.cjs";
import { alertError } from "src/ts/alert";
import { addFetchLog, fetchNative } from "src/ts/globalApi.svelte";
import { LLMFlags } from "src/ts/model/modellist";
import { getDatabase } from "src/ts/storage/database.svelte";
import { callTool, encodeToolCall } from "../../mcp/mcp";
import { extractJSON } from "../../templates/jsonSchema";
import type { RequestDataArgumentExtended, StreamResponseChunk } from "../requestContracts";
import { resolveRequestParserContext } from "../requestContext";
import type { OpenAIChatExtra, ToolCall } from "./types";
import type { LocalNetworkRequestOptions } from "./shared";

export function getTranStream(
  arg: RequestDataArgumentExtended,
): TransformStream<Uint8Array, StreamResponseChunk> {
  let dataUint: Uint8Array | Buffer = new Uint8Array([]);
  let reasoningContent = "";
  let reasoningFromStructured = false;
  const db = getDatabase();

  return new TransformStream<Uint8Array, StreamResponseChunk>({
    transform(chunk, control) {
      const combined = new Uint8Array(dataUint.length + chunk.length);
      combined.set(dataUint, 0);
      combined.set(chunk, dataUint.length);
      dataUint = Buffer.from(combined);
      let JSONreaded: { [key: string]: string } = {};
      reasoningContent = "";
      try {
        const datas = dataUint.toString().split("\n");
        let readed: { [key: string]: string } = {};
        for (const data of datas) {
          if (data.startsWith("data: ")) {
            try {
              const rawChunk = data.replace("data: ", "");
              if (rawChunk === "[DONE]") {
                if (
                  arg.modelInfo.flags.includes(
                    LLMFlags.deepSeekThinkingOutput,
                  ) &&
                  !reasoningFromStructured
                ) {
                  readed["0"] = readed["0"].replace(
                    /(.*)\<\/think\>/gms,
                    (m, p1) => {
                      reasoningContent = p1;
                      return "";
                    },
                  );

                  if (reasoningContent) {
                    reasoningContent = reasoningContent.replace(
                      /\<think\>/gm,
                      "",
                    );
                  }
                }
                if (arg.extractJson && (db.jsonSchemaEnabled || arg.schema)) {
                  for (const key in readed) {
                    const extracted = extractJSON(readed[key], arg.extractJson, resolveRequestParserContext(arg));
                    JSONreaded[key] = extracted;
                  }
                  console.log(JSONreaded);
                  control.enqueue(JSONreaded);
                } else if (reasoningContent) {
                  const chunk: Record<string, string> = {
                    "0": `<Thoughts>\n${reasoningContent}\n</Thoughts>\n${readed["0"] ?? ""}`,
                  };
                  if (readed["__tool_calls"]) {
                    chunk["__tool_calls"] = readed["__tool_calls"];
                  }
                  control.enqueue(chunk);
                } else {
                  control.enqueue(readed);
                }
                return;
              }
              const choices = JSON.parse(rawChunk).choices;
              for (const choice of choices) {
                const chunk = choice.delta.content ?? choice.text;
                if (chunk) {
                  if (arg.multiGen) {
                    const ind = choice.index.toString();
                    if (!readed[ind]) {
                      readed[ind] = "";
                    }
                    readed[ind] = appendOpenAIStreamingFragment(readed[ind], chunk);
                  } else {
                    if (!readed["0"]) {
                      readed["0"] = "";
                    }
                    readed["0"] = appendOpenAIStreamingFragment(readed["0"], chunk);
                  }
                }
                // Check for tool calls in the delta
                if (choice?.delta?.tool_calls) {
                  const currentToolCalls = JSON.parse(
                    readed["__tool_calls"] || "{}",
                  );
                  readed["__tool_calls"] = JSON.stringify(
                    mergeOpenAIStreamingToolCallDeltas(
                      currentToolCalls,
                      choice.delta.tool_calls,
                    ),
                  );
                }
                const reasoningChunk =
                  choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
                if (reasoningChunk) {
                  reasoningFromStructured = true;
                  reasoningContent = appendOpenAIStreamingFragment(
                    reasoningContent,
                    reasoningChunk,
                  );
                }
              }
            } catch (error) {}
          }
        }

        if (
          arg.modelInfo.flags.includes(LLMFlags.deepSeekThinkingOutput) &&
          !reasoningFromStructured
        ) {
          readed["0"] = readed["0"].replace(/(.*)\<\/think\>/gms, (m, p1) => {
            reasoningContent = p1;
            return "";
          });

          if (reasoningContent) {
            reasoningContent = reasoningContent.replace(/\<think\>/gm, "");
          }
        }
        if (arg.extractJson && (db.jsonSchemaEnabled || arg.schema)) {
          for (const key in readed) {
            const extracted = extractJSON(readed[key], arg.extractJson, resolveRequestParserContext(arg));
            JSONreaded[key] = extracted;
          }
          console.log(JSONreaded);
          control.enqueue(JSONreaded);
        } else if (reasoningContent) {
          const chunk: Record<string, string> = {
            "0": `<Thoughts>\n${reasoningContent}\n</Thoughts>\n${readed["0"] ?? ""}`,
          };
          if (readed["__tool_calls"]) {
            chunk["__tool_calls"] = readed["__tool_calls"];
          }
          control.enqueue(chunk);
        } else {
          control.enqueue(readed);
        }
      } catch (error) {}
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
      const db = getDatabase();
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

          const toolCalls = Object.values(
            JSON.parse(value?.["__tool_calls"] || "{}") || {},
          ) as ToolCall[];
          if (toolCalls && toolCalls.length > 0) {
            const messages = body.messages as OpenAIChatExtra[];
            let assistantContent = content;
            let assistantReasoningContent = "";
            const shouldPassDeepSeekReasoning =
              arg.modelInfo.flags.includes(LLMFlags.deepSeekThinkingInput) ||
              (arg.modelInfo.flags.includes(LLMFlags.deepSeekThinkingToggle) &&
                db.deepseekThinkingType === "enabled");

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
                    const x = (await callTool(tool.name, parsed, tool.mcpURL)).filter(
                      (m) => m.type === "text",
                    );
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
