import { safeStructuredClone } from "../../../polyfill";
import { decodeToolCall } from "../../mcp/mcp";
import type { Contents, OpenAIChatExtra } from "./types";

async function expandRememberedToolCalls(
  text: string,
  originalMessage: OpenAIChatExtra,
): Promise<OpenAIChatExtra[]> {
  const segments = text.split(/(<tool_call>.*?<\/tool_call>)/gms);
  const processedMessages: OpenAIChatExtra[] = [];
  let currentContent = "";

  for (const segment of segments) {
    const toolCallMatch = segment.match(/<tool_call>(.*?)<\/tool_call>/s);
    if (!toolCallMatch) {
      currentContent += segment;
      continue;
    }

    const call = await decodeToolCall(toolCallMatch[1]);
    if (!call) continue;
    processedMessages.push({
      ...originalMessage,
      role: "assistant",
      content: currentContent,
      tool_calls: [
        {
          id: call.call.id,
          type: "function",
          function: { name: call.call.name, arguments: call.call.arg },
        },
      ],
    });
    const textContents = call.response
      .filter((item) => item.type === "text")
      .map((item) => item.text);
    processedMessages.push({
      role: "tool",
      content: textContents.join("\n"),
      tool_call_id: call.call.id,
      cachePoint: true,
    });
    currentContent = "";
  }

  if (currentContent.trim()) {
    processedMessages.push({
      ...originalMessage,
      role: "assistant",
      content: currentContent,
    });
  }
  return processedMessages;
}

export async function prepareOpenAIProviderMessages(
  messages: OpenAIChatExtra[],
  visionQuality: string,
): Promise<OpenAIChatExtra[]> {
  const prepared: OpenAIChatExtra[] = [];
  for (const message of messages) {
    if (
      typeof message.content === "string" &&
      message.content.includes("<tool_call>")
    ) {
      prepared.push(
        ...(await expandRememberedToolCalls(message.content, message)),
      );
      continue;
    }
    if (message.multimodals?.length && message.role === "user") {
      const cloned = safeStructuredClone(message);
      const contents: Contents[] = message.multimodals.map((multimodal) => ({
        type: "image_url",
        image_url: {
          url: multimodal.base64,
          detail: visionQuality,
        },
      }));
      contents.push({ type: "text", text: message.content as string });
      cloned.content = contents;
      prepared.push(cloned);
      continue;
    }

    prepared.push(message);
  }
  return prepared;
}
