import { language } from "src/lang";
import { alertError } from "src/ts/alert";
import { LLMFlags } from "src/ts/model/modellist";
import { getDatabase } from "src/ts/storage/database.svelte";
import { callTool, encodeToolCall } from "../../mcp/mcp";
import { extractJSON } from "../../templates/jsonSchema";
import type {
  RequestDataArgumentExtended,
  requestDataResponse,
} from "../request";
import type { OpenAIChatExtra, OpenAIChatFull, ToolCall } from "./types";

export interface InterpretOpenAINonStreamingOptions {
  ok: boolean;
  data: unknown;
  body: Record<string, any>;
  arg: RequestDataArgumentExtended;
  retry: () => Promise<requestDataResponse>;
}

export async function interpretOpenAINonStreamingResponse(
  options: InterpretOpenAINonStreamingOptions,
): Promise<requestDataResponse> {
  const { ok, data, body, arg, retry } = options;
  const db = getDatabase();
  function processTextResponse(dat: any): string {
    if (dat?.choices[0]?.text) {
      let text = dat.choices[0].text as string;
      if (arg.extractJson && (db.jsonSchemaEnabled || arg.schema)) {
        try {
          const parsed = JSON.parse(text);
          const extracted = extractJSON(parsed, arg.extractJson);
          return extracted;
        } catch (error) {
          console.log(error);
          return text;
        }
      }
      return text;
    }
    if (arg.extractJson && (db.jsonSchemaEnabled || arg.schema)) {
      return extractJSON(dat.choices[0].message.content, arg.extractJson);
    }
    const msg: OpenAIChatFull = dat.choices[0].message;
    let result = msg.content ?? "";
    const reasoningContentField =
      dat?.choices[0]?.reasoning_content ??
      dat?.choices[0]?.message?.reasoning_content;
    if (
      arg.modelInfo.flags.includes(LLMFlags.deepSeekThinkingOutput) &&
      !reasoningContentField
    ) {
      let reasoningContent = "";
      result = result.replace(/(.*)\<\/think\>/gms, (m, p1) => {
        reasoningContent = p1;
        return "";
      });
      if (reasoningContent) {
        reasoningContent = reasoningContent.replace(/\<think\>/gms, "");
        result = `<Thoughts>\n${reasoningContent}\n</Thoughts>\n${result}`;
      }
    }
    if (reasoningContentField && !result.startsWith("<Thoughts>")) {
      result = `<Thoughts>\n${reasoningContentField}\n</Thoughts>\n${result}`;
    }
    // For openrouter, https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request#response.body.choices.message.reasoning
    if (dat?.choices?.[0]?.message?.reasoning) {
      result = `<Thoughts>\n${dat.choices[0].message.reasoning}\n</Thoughts>\n${result}`;
    }

    return result;
  }

  const dat = data as any;

  if (ok) {
    try {
      // Collect all tool_calls from all choices
      let allToolCalls: ToolCall[] = [];
      if (dat.choices) {
        for (const choice of dat.choices) {
          if (
            choice.message?.tool_calls &&
            choice.message.tool_calls.length > 0
          ) {
            allToolCalls = allToolCalls.concat(choice.message.tool_calls);
          }
        }
      }

      // Replace choices[0].message.tool_calls with all collected tool calls
      if (dat.choices?.[0]?.message && allToolCalls.length > 0) {
        dat.choices[0].message.tool_calls = allToolCalls;
      }

      if (
        dat.choices?.[0]?.message?.tool_calls &&
        dat.choices[0].message.tool_calls.length > 0
      ) {
        const toolCalls = dat.choices[0].message.tool_calls as ToolCall[];

        const messages = body.messages as OpenAIChatExtra[];

        messages.push(dat.choices[0].message);

        // Remove the last message content if simplifiedToolUse is enabled
        if (db.simplifiedToolUse && messages[messages.length - 1].content) {
          messages[messages.length - 1].content = "";
        }

        const callCodes: string[] = [];

        for (const toolCall of toolCalls) {
          if (
            !toolCall.function ||
            !toolCall.function.name ||
            toolCall.function.arguments === undefined ||
            toolCall.function.arguments === null
          ) {
            continue;
          }
          try {
            const functionArgs = toolCall.function.arguments
              ? JSON.parse(toolCall.function.arguments)
              : {};
            if (arg.tools && arg.tools.length > 0) {
              const tool = arg.tools.find(
                (t) => t.name === toolCall.function.name,
              );
              if (!tool) {
                messages.push({
                  role: "tool",
                  content: "No tool found with name: " + toolCall.function.name,
                  tool_call_id: toolCall.id,
                });
              } else {
                const parsed = functionArgs;
                const x = (await callTool(tool.name, parsed)).filter(
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

        // Send the next request recursively
        let resRec;
        let attempt = 0;

        do {
          attempt++;
          resRec = await retry();

          if (resRec.type != "fail") {
            break;
          }
        } while (attempt <= db.requestRetrys); // Retry up to db.requestRetrys times

        const callCode = callCodes.join("\n\n");

        // Combine the tool call results with the main response (does not include text response if simplifiedToolUse is enabled)
        const result =
          (db.simplifiedToolUse
            ? ""
            : (processTextResponse(dat) ?? "") + "\n\n") + callCode;

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

      if (arg.multiGen && dat.choices) {
        if (arg.extractJson && (db.jsonSchemaEnabled || arg.schema)) {
          const c = dat.choices.map((v: { message: { content: string } }) => {
            const extracted = extractJSON(
              v.message.content ?? "",
              arg.extractJson,
            );
            return ["char", extracted];
          });

          return {
            type: "multiline",
            result: c,
          };
        }
        return {
          type: "multiline",
          result: dat.choices.map((v) => {
            return ["char", v.message.content ?? ""];
          }),
        };
      }

      const result = processTextResponse(dat) ?? "";

      return {
        type: "success",
        result: result,
      };
    } catch (error) {
      return {
        type: "fail",
        result: language.errors.httpError + `${JSON.stringify(dat)}`,
      };
    }
  }

  if (dat.error && dat.error.message) {
    return {
      type: "fail",
      result: language.errors.httpError + `${dat.error.message}`,
    };
  }

  return {
    type: "fail",
    result: language.errors.httpError + `${JSON.stringify(data)}`,
  };
}
